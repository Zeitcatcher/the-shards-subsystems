/**
 * Izir content: load, validate, and index `data/izir/content.json` — the single
 * source of truth for all boons, banes, and pack-resident aura effects.
 *
 * `indexContent` / `validateContent` are pure (no Foundry) so the CI script
 * (scripts/validate-content.mjs) reuses the exact same validation.
 */

import { MODULE_ID } from "../../core/constants.mjs";

const KINDS = new Set(["boon", "bane"]);
// "spell" is gone until there is a spell path to build: the composer has no branch
// for it, so an entry authored that way would validate and then quietly do
// nothing. (F31)
const FORMS = new Set(["effect", "action", "strike"]);
const GATES = new Set([null, undefined, "subjugated"]);

/** A 16-character Foundry document id: letters and digits only, never a hyphen. */
const DOC_ID = /^[A-Za-z0-9]{16}$/;

/** A recharge is a die formula. "1da" used to validate and fail at the table. */
const RECHARGE = /^\d+d\d+([+-]\d+)?$/;

/** The token content uses to point a rule at a document in the internal pack. */
const packToken = (id) => `{{izirPack:${id}}}`;

let cached = null;

/** Load + index the content file once, caching the result. Foundry runtime only. */
export async function loadContent() {
  if (cached) return cached;
  const path = `modules/${MODULE_ID}/data/izir/content.json`;
  const raw = await foundry.utils.fetchJsonWithTimeout(path);
  cached = indexContent(raw);
  return cached;
}

/** Drop the cache (e.g. after a hot content edit during dev). */
export function clearContentCache() {
  cached = null;
}

/**
 * Validate and index raw content. Throws an Error listing every problem found.
 * @returns {{entries:Array, byId:Map, byFamily:Map, packEffects:Array}}
 */
export function indexContent(raw) {
  const problems = validateContent(raw);
  if (problems.length) {
    throw new Error(`Izir content invalid:\n - ${problems.join("\n - ")}`);
  }
  const entries = raw.entries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byFamily = new Map();
  for (const e of entries) {
    if (!byFamily.has(e.family)) byFamily.set(e.family, []);
    byFamily.get(e.family).push(e);
  }
  // No `version` and no `tiers`: both were indexed and read by nobody. TIERS in
  // logic/model.mjs is the real source of the tier bands. (F31)
  return { entries, byId, byFamily, packEffects: raw.packEffects ?? [] };
}

/**
 * Return an array of human-readable problems (empty = valid). Pure.
 */
export function validateContent(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return ["root is not an object"];

  const entries = raw.entries;
  if (!Array.isArray(entries)) return ["`entries` is missing or not an array"];

  const seen = new Set();
  const packIds = new Set((raw.packEffects ?? []).map((p) => p?._id));

  for (const [i, e] of entries.entries()) {
    const at = `entry[${i}]${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") { problems.push(`${at}: not an object`); continue; }
    if (typeof e.id !== "string" || !e.id) problems.push(`${at}: missing id`);
    else if (seen.has(e.id)) problems.push(`${at}: duplicate id`);
    else seen.add(e.id);
    if (typeof e.family !== "string" || !e.family) problems.push(`${at}: missing family`);
    if (!Number.isInteger(e.rank)) problems.push(`${at}: rank must be an integer`);
    if (!Number.isInteger(e.level) || e.level < 0 || e.level > 10) problems.push(`${at}: level must be 0..10`);
    if (!KINDS.has(e.kind)) problems.push(`${at}: kind must be boon|bane`);
    if (!FORMS.has(e.form)) problems.push(`${at}: form must be ${[...FORMS].join("|")}`);
    if (!GATES.has(e.gate)) problems.push(`${at}: gate must be omitted or "subjugated"`);
    if (typeof e.name !== "string" || !e.name) problems.push(`${at}: missing name`);
    if (e.rules != null && !Array.isArray(e.rules)) problems.push(`${at}: rules must be an array`);
    // The composer builds an action item from actionData and drops the rules; the
    // pack copy keeps them. Authoring rules here means two different abilities
    // wearing one name. (F31)
    if (e.form === "action" && Array.isArray(e.rules) && e.rules.length) {
      problems.push(`${at}: an action entry cannot carry rules (the tracker drops them)`);
    }
    if (e.form === "action" && e.actionData == null) problems.push(`${at}: action form needs actionData`);
    if (e.form === "strike" && (e.strikeData == null || typeof e.strikeData !== "object")) {
      problems.push(`${at}: strike form needs strikeData`);
    }
    if (e.actionData?.recharge != null && !RECHARGE.test(String(e.actionData.recharge))) {
      problems.push(`${at}: actionData.recharge must be a die formula like 1d6`);
    }
    if (e.auraEffectId && !packIds.has(e.auraEffectId)) {
      problems.push(`${at}: auraEffectId "${e.auraEffectId}" has no matching packEffect._id`);
    }
    // auraEffectId used to be validated and then read by nobody, while the Aura
    // rule carried a hand-copied literal. They have to name the same document. (F31)
    if (e.auraEffectId) {
      const uuids = (Array.isArray(e.rules) ? e.rules : [])
        .filter((r) => r?.key === "Aura")
        .flatMap((r) => (Array.isArray(r.effects) ? r.effects : []))
        .map((x) => x?.uuid);
      const wanted = packToken(e.auraEffectId);
      for (const u of uuids) {
        if (u !== wanted) problems.push(`${at}: Aura effect uuid "${u}" should be "${wanted}"`);
      }
      if (!uuids.length) problems.push(`${at}: auraEffectId is set but no Aura rule references it`);
    }
    if (e.actionData?.selfEffectId && !packIds.has(e.actionData.selfEffectId)) {
      problems.push(`${at}: actionData.selfEffectId "${e.actionData.selfEffectId}" has no matching packEffect._id`);
    }
    if (e.chipTag != null && typeof e.chipTag !== "string") problems.push(`${at}: chipTag must be a string`);
  }

  for (const [i, p] of (raw.packEffects ?? []).entries()) {
    const at = `packEffect[${i}]${p?._id ? ` (${p._id})` : ""}`;
    // A hyphen in a 16-character id passed the length check and then never
    // resolved as a document id. (F31)
    if (typeof p?._id !== "string" || !DOC_ID.test(p._id)) {
      problems.push(`${at}: _id must be 16 characters, letters and digits only`);
    }
    if (typeof p?.name !== "string" || !p.name) problems.push(`${at}: missing name`);
    if (p?.durationMinutes != null && !Number.isInteger(p.durationMinutes)) {
      problems.push(`${at}: durationMinutes must be an integer`);
    }
  }

  return problems;
}
