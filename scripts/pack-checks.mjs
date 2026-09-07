/**
 * Pure checks over the generated pack sources, shared by the CI script
 * (scripts/validate-content.mjs) and the suite (test/ansu-packs.test.mjs) so a
 * local build-and-test cycle catches what CI catches.
 *
 * No file reading here: callers hand in text or parsed documents.
 */

import { tempHpFor, resistFor, parryFor, tierDiceFor } from "../src/subsystems/ansu/logic/model.mjs";

const MODULE_ID = "the-shards-subsystems";

/**
 * The number tokens a rule element may carry, mapped to the runtime function
 * that computes them. Imported from model.mjs rather than restated, so a pack
 * copy and a live sheet cannot disagree about what a number is.
 */
export const ANSU_RULE_TOKEN_FNS = Object.freeze({
  "{{ansuTempHp}}": tempHpFor,
  "{{ansuResist}}": resistFor,
  "{{ansuParry}}": parryFor,
  "{{ansuTierDice}}": tierDiceFor,
});

/** Every rule token resolved at one entry's unlock attunement. */
export function ansuRuleTokenValues(entry) {
  const level = Math.max(1, Math.trunc(Number(entry?.level)) || 1);
  const out = {};
  for (const [token, fn] of Object.entries(ANSU_RULE_TOKEN_FNS)) out[token] = fn(level);
  return out;
}

/** True when any of the entry's rule elements holds a number token. */
export function ansuRulesCarryTokens(entry) {
  const rules = Array.isArray(entry?.rules) ? entry.rules : [];
  return rules.some((r) =>
    Object.values(r ?? {}).some(
      (v) => typeof v === "string" && Object.keys(ANSU_RULE_TOKEN_FNS).some((t) => v.includes(t)),
    ),
  );
}

/**
 * What a scrubbed rule value must end up as: the number itself when the value IS
 * the token, otherwise the string with every token replaced in place.
 */
export function ansuScrubbedValue(value, subs) {
  if (typeof value !== "string") return value;
  const hits = Object.entries(subs).filter(([token]) => value.includes(token));
  if (!hits.length) return value;
  if (hits.length === 1 && value === hits[0][0]) return hits[0][1];
  let out = value;
  for (const [token, num] of hits) out = out.replaceAll(token, String(num));
  return out;
}

/**
 * Two defect classes the content schema can't see: unresolved {{tokens}} that
 * slipped past a scrub, and inline @Check enrichers whose dc is prose (a letter
 * after "dc:") instead of a number, a path, or empty. Both shipped broken before
 * this guard existed.
 */
export function packSourceTextProblems(name, text) {
  const problems = [];
  if (String(text).includes("{{")) problems.push(`pack source ${name}: unresolved {{token}} left in a static pack copy`);
  if (/dc:[A-Za-z]/.test(String(text))) {
    problems.push(`pack source ${name}: malformed inline @Check dc (prose after "dc:")`);
  }
  return problems;
}

/**
 * Every generated Ansu document whose content entry carried a number token must
 * hold that number computed at the entry's own unlock attunement. The Union
 * upgrade of Ancestral Vigor shipped 3 temporary Hit Points against its own
 * "three times your attunement" for four releases, because the scrub replaced
 * each token with one flat constant. This closes the class, not the file. (0.6.6)
 *
 * @param {object} content parsed data/ansu/content.json
 * @param {Array<object>} docs parsed src/packs/ansu-effects/*.json
 */
export function ansuBakedNumberProblems(content, docs) {
  const problems = [];
  const byEntryId = new Map();
  for (const d of docs ?? []) {
    const entryId = d?.flags?.[MODULE_ID]?.ansuPack?.entryId;
    if (entryId) byEntryId.set(entryId, d);
  }

  for (const entry of content?.entries ?? []) {
    if (!ansuRulesCarryTokens(entry)) continue;
    const doc = byEntryId.get(entry.id);
    if (!doc) {
      problems.push(`pack source for ${entry.id}: missing, but its rules carry a number token`);
      continue;
    }
    const subs = ansuRuleTokenValues(entry);
    const built = Array.isArray(doc.system?.rules) ? doc.system.rules : [];
    for (const [i, rule] of (entry.rules ?? []).entries()) {
      for (const [k, v] of Object.entries(rule ?? {})) {
        const expected = ansuScrubbedValue(v, subs);
        if (expected === v) continue;
        const got = built[i]?.[k];
        if (got !== expected) {
          problems.push(
            `pack source for ${entry.id}: rule[${i}].${k} is ${JSON.stringify(got)}, ` +
              `expected ${JSON.stringify(expected)} at attunement ${entry.level}`,
          );
        }
      }
    }
  }
  return problems;
}
