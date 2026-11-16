/**
 * Ansu deeds (`data/ansu/deeds.json`): the reasons loyalty and wrath move.
 * Pure (no Foundry): the CI script (scripts/validate-content.mjs) and the tests
 * reuse this validation. A deed moves wrath by `wrath` or sets it with
 * `wrathSet`, never both; `wrathSkipAtLoyalty0` skips the wrath move at loyalty 0.
 */

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEYS = new Set(["id", "label", "loyalty", "wrath", "wrathSet", "wrathSkipAtLoyalty0", "picker", "auto"]);

const isInt = (v) => Number.isInteger(v);

/** Return an array of human-readable problems (empty = valid). */
export function validateDeeds(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return ["deeds file is not an object"];
  if (!Array.isArray(raw.deeds) || raw.deeds.length === 0) return ["`deeds` must be a non-empty array"];
  const seen = new Set();
  raw.deeds.forEach((d, i) => {
    const at = `deeds[${i}]${d?.id ? ` (${d.id})` : ""}`;
    if (!d || typeof d !== "object") {
      problems.push(`${at}: not an object`);
      return;
    }
    for (const k of Object.keys(d)) if (!KEYS.has(k)) problems.push(`${at}: unknown key "${k}"`);
    if (typeof d.id !== "string" || !ID_RE.test(d.id)) problems.push(`${at}: id must be kebab-case`);
    else if (seen.has(d.id)) problems.push(`${at}: duplicate id`);
    else seen.add(d.id);
    if (typeof d.label !== "string" || !d.label.trim()) problems.push(`${at}: label required`);
    else if (/[—–]/.test(d.label)) problems.push(`${at}: label has a dash (em/en)`);
    if (!isInt(d.loyalty) || d.loyalty < -10 || d.loyalty > 10) problems.push(`${at}: loyalty must be an integer -10..10`);
    const hasDelta = d.wrath !== undefined;
    const hasSet = d.wrathSet !== undefined;
    if (hasDelta === hasSet) problems.push(`${at}: exactly one of wrath / wrathSet`);
    if (hasDelta && (!isInt(d.wrath) || d.wrath < -6 || d.wrath > 6)) problems.push(`${at}: wrath must be an integer -6..6`);
    if (hasSet && (!isInt(d.wrathSet) || d.wrathSet < 0 || d.wrathSet > 6)) problems.push(`${at}: wrathSet must be an integer 0..6`);
    if (d.wrathSkipAtLoyalty0 !== undefined && typeof d.wrathSkipAtLoyalty0 !== "boolean") {
      problems.push(`${at}: wrathSkipAtLoyalty0 must be boolean`);
    }
    if (typeof d.picker !== "boolean") problems.push(`${at}: picker must be boolean`);
    if (typeof d.auto !== "boolean") problems.push(`${at}: auto must be boolean`);
    if (d.picker === false && d.auto === false) problems.push(`${at}: neither picker nor auto (unreachable)`);
  });
  return problems;
}

/** Validate and index; throws on any problem. @returns {{deeds:Array, byId:Map, picker:Array}} */
export function indexDeeds(raw) {
  const problems = validateDeeds(raw);
  if (problems.length) throw new Error(`Ansu deeds invalid:\n - ${problems.join("\n - ")}`);
  const deeds = raw.deeds;
  return { deeds, byId: new Map(deeds.map((d) => [d.id, d])), picker: deeds.filter((d) => d.picker) };
}
