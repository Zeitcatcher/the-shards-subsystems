/**
 * Ansu content: load, validate, and index `data/ansu/content.json` — the single
 * source of truth for every Communion boon, Inheritance passive, and active.
 *
 * `indexContent` / `validateContent` are pure (no Foundry) so the CI script
 * (scripts/validate-content.mjs) reuses the exact same validation.
 */

import { MODULE_ID } from "../../core/constants.mjs";

const KINDS = new Set(["boon"]);
const FORMS = new Set(["effect", "action", "strike", "feat"]);
const GATES = new Set([null, undefined, "subjugated"]);

let cached = null;

/** Load + index the content file once, caching the result. Foundry runtime only. */
export async function loadContent() {
  if (cached) return cached;
  const path = `modules/${MODULE_ID}/data/ansu/content.json`;
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
 * @returns {{version:number, entries:Array, byId:Map, byFamily:Map, tiers:Array}}
 */
export function indexContent(raw) {
  const problems = validateContent(raw);
  if (problems.length) {
    throw new Error(`Ansu content invalid:\n - ${problems.join("\n - ")}`);
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
  // selectEntries picks a family's live entry with a strict `>` on rank, so a tie
  // silently drops whichever entry the array happens to list second, rules and
  // all. The build's own duplicate guard compares _ids, which differ. (0.6.6)
  const seenFamilyRank = new Set();

  for (const [i, e] of entries.entries()) {
    const at = `entry[${i}]${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") { problems.push(`${at}: not an object`); continue; }
    if (typeof e.id !== "string" || !e.id) problems.push(`${at}: missing id`);
    else if (seen.has(e.id)) problems.push(`${at}: duplicate id`);
    else seen.add(e.id);
    if (typeof e.family !== "string" || !e.family) problems.push(`${at}: missing family`);
    if (!Number.isInteger(e.rank)) problems.push(`${at}: rank must be an integer`);
    if (!Number.isInteger(e.level) || e.level < 0 || e.level > 10) problems.push(`${at}: level must be 0..10`);
    if (!KINDS.has(e.kind)) problems.push(`${at}: kind must be boon (Ansu has no banes)`);
    if (!FORMS.has(e.form)) problems.push(`${at}: form must be effect|action|strike`);
    if (!GATES.has(e.gate)) problems.push(`${at}: gate must be omitted or "subjugated"`);
    if (typeof e.name !== "string" || !e.name) problems.push(`${at}: missing name`);
    if (e.rules != null && !Array.isArray(e.rules)) problems.push(`${at}: rules must be an array`);
    if (e.always != null && typeof e.always !== "boolean") problems.push(`${at}: always must be a boolean`);
    if (e.always && e.form !== "feat") problems.push(`${at}: always-on entries must be feat-form (bonus feats, not buffs)`);
    if (e.form === "feat" && !e.always) problems.push(`${at}: feat form is for always-on Inheritance — set always: true`);
    if (e.form === "action" && e.actionData == null) problems.push(`${at}: action form needs actionData`);
    if (e.form === "strike" && (e.strikeData == null || typeof e.strikeData !== "object")) {
      problems.push(`${at}: strike form needs strikeData`);
    }
    if (e.terminalActionData != null && e.form !== "action") {
      problems.push(`${at}: terminalActionData only applies to action form`);
    }
    // Both action blocks get the same treatment: composeActions swaps in
    // terminalActionData wholesale for a subjugated master, so a typo there
    // reaches the sheet exactly like one in actionData would. (0.6.6)
    for (const key of ["actionData", "terminalActionData"]) {
      const a = e[key];
      if (a == null) continue;
      if (typeof a !== "object" || Array.isArray(a)) { problems.push(`${at}: ${key} must be an object`); continue; }
      if (a.perCommunion != null && typeof a.perCommunion !== "boolean") {
        problems.push(`${at}: ${key}.perCommunion must be a boolean`);
      }
      if (a.perCommunion && !a.frequency) {
        problems.push(`${at}: ${key} perCommunion needs a frequency (the Use button + the counter the module resets)`);
      }
      if (a.alwaysAvailable != null && typeof a.alwaysAvailable !== "boolean") {
        problems.push(`${at}: ${key}.alwaysAvailable must be a boolean`);
      }
      if (a.cooldownMinutes != null && !Number.isInteger(a.cooldownMinutes)) {
        problems.push(`${at}: ${key}.cooldownMinutes must be an integer`);
      }
      if (Number.isInteger(a.cooldownMinutes) && !a.frequency) {
        problems.push(`${at}: ${key} cooldownMinutes needs a frequency (the Use button the cooldown disables)`);
      }
    }
    if (e.chipTag != null && typeof e.chipTag !== "string") problems.push(`${at}: chipTag must be a string`);
    // Guarded on the already-validated types so a missing family reports once.
    if (typeof e.family === "string" && e.family && Number.isInteger(e.rank)) {
      const key = `${e.family}::${e.rank}`;
      if (seenFamilyRank.has(key)) {
        problems.push(`${at}: duplicate family/rank (${e.family} rank ${e.rank}), only one of these will ever compose`);
      } else seenFamilyRank.add(key);
    }
  }

  return problems;
}
