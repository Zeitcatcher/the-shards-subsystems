/**
 * Izir content: load, validate, and index `data/izir/content.json` — the single
 * source of truth for all boons, banes, and pack-resident aura effects.
 *
 * `indexContent` / `validateContent` are pure (no Foundry) so the CI script
 * (scripts/validate-content.mjs) reuses the exact same validation.
 */

import { MODULE_ID } from "../../core/constants.mjs";

const KINDS = new Set(["boon", "bane"]);
const FORMS = new Set(["effect", "action", "spell", "strike"]);
const GATES = new Set([null, undefined, "subjugated"]);

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
 * @returns {{version:number, entries:Array, byId:Map, byFamily:Map, tiers:Array, packEffects:Array}}
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
  return {
    version: raw.version ?? 1,
    entries,
    byId,
    byFamily,
    tiers: raw.tiers ?? [],
    packEffects: raw.packEffects ?? [],
  };
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
    if (!FORMS.has(e.form)) problems.push(`${at}: form must be effect|action|spell`);
    if (!GATES.has(e.gate)) problems.push(`${at}: gate must be omitted or "subjugated"`);
    if (typeof e.name !== "string" || !e.name) problems.push(`${at}: missing name`);
    if (e.rules != null && !Array.isArray(e.rules)) problems.push(`${at}: rules must be an array`);
    if (e.form === "action" && e.actionData == null) problems.push(`${at}: action form needs actionData`);
    if (e.form === "spell" && e.spellData == null) problems.push(`${at}: spell form needs spellData`);
    if (e.form === "strike" && (e.strikeData == null || typeof e.strikeData !== "object")) {
      problems.push(`${at}: strike form needs strikeData`);
    }
    if (e.actionData?.recharge != null && typeof e.actionData.recharge !== "string") {
      problems.push(`${at}: actionData.recharge must be a roll formula string`);
    }
    if (e.auraEffectId && !packIds.has(e.auraEffectId)) {
      problems.push(`${at}: auraEffectId "${e.auraEffectId}" has no matching packEffect._id`);
    }
  }

  for (const [i, p] of (raw.packEffects ?? []).entries()) {
    const at = `packEffect[${i}]${p?._id ? ` (${p._id})` : ""}`;
    if (typeof p?._id !== "string" || p._id.length !== 16) problems.push(`${at}: _id must be a 16-char string`);
    if (typeof p?.name !== "string" || !p.name) problems.push(`${at}: missing name`);
  }

  return problems;
}
