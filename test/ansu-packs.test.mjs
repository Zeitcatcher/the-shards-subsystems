import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ansuRuleTokenValues,
  ansuRulesCarryTokens,
  ansuScrubbedValue,
  packSourceTextProblems,
  ansuBakedNumberProblems,
} from "../scripts/pack-checks.mjs";
import { tempHpFor, resistFor, parryFor, tierDiceFor } from "../src/subsystems/ansu/logic/model.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = resolve(ROOT, "src/packs/ansu-effects");
const content = JSON.parse(readFileSync(resolve(ROOT, "data/ansu/content.json"), "utf8"));
const files = readdirSync(PACK_DIR).filter((f) => f.endsWith(".json"));
const docs = files.map((f) => JSON.parse(readFileSync(resolve(PACK_DIR, f), "utf8")));

/**
 * The generated pack-source scan used to run only in CI, so a local
 * build-and-test cycle could not catch a token that leaked into src/packs.
 * These are the same pure checks scripts/validate-content.mjs runs. (items 34, 37)
 */
describe("src/packs/ansu-effects", () => {
  it("ships a document per content entry plus the tier folders", () => {
    expect(files.length).toBe(content.entries.length + 4);
  });

  it("leaves no unresolved {{token}} and no prose @Check dc", () => {
    const problems = [];
    for (const f of files) problems.push(...packSourceTextProblems(f, readFileSync(resolve(PACK_DIR, f), "utf8")));
    expect(problems).toEqual([]);
  });

  it("bakes every rule number at the entry's own unlock attunement", () => {
    expect(ansuBakedNumberProblems(content, docs)).toEqual([]);
  });

  it("gives the Union upgrade of Ancestral Vigor its 21 temporary Hit Points", () => {
    // The scrub used to write one flat constant per token whatever the entry, so
    // this document shipped 3 against its own "three times your attunement".
    const entry = content.entries.find((e) => e.id === "ancestral-vigor-2");
    const doc = docs.find((d) => d?.flags?.["the-shards-subsystems"]?.ansuPack?.entryId === "ancestral-vigor-2");
    expect(entry.level).toBe(7);
    expect(tempHpFor(entry.level)).toBe(21);
    expect(doc.system.rules.find((r) => r.key === "TempHP").value).toBe(21);
    expect(doc.system.description.value).toContain("fixed at attunement 7");
  });

  it("leaves the three entries gated at their own level unchanged", () => {
    const at = (id) => docs.find((d) => d?.flags?.["the-shards-subsystems"]?.ansuPack?.entryId === id).system.rules;
    expect(at("ancestral-vigor").find((r) => r.key === "TempHP").value).toBe(tempHpFor(1));
    expect(at("salbarine-skin").find((r) => r.key === "Resistance").value).toBe(resistFor(5));
    expect(at("makers-wrath").find((r) => r.key === "DamageDice").diceNumber).toBe(tierDiceFor(1));
  });

  it("says which attunement a baked copy's numbers belong to, and only where numbers were baked", () => {
    for (const doc of docs) {
      const entryId = doc?.flags?.["the-shards-subsystems"]?.ansuPack?.entryId;
      if (!entryId) continue;
      const entry = content.entries.find((e) => e.id === entryId);
      const said = doc.system.description.value.includes("fixed at attunement");
      expect(said, `${entryId} note presence`).toBe(ansuRulesCarryTokens(entry));
    }
  });
});

describe("pack-checks helpers", () => {
  it("resolves every token from model.mjs at the given level", () => {
    expect(ansuRuleTokenValues({ level: 7 })).toEqual({
      "{{ansuTempHp}}": tempHpFor(7),
      "{{ansuResist}}": resistFor(7),
      "{{ansuParry}}": parryFor(7),
      "{{ansuTierDice}}": tierDiceFor(7),
    });
  });

  it("floors junk levels at attunement 1", () => {
    for (const level of [undefined, null, 0, -3, "x", NaN]) {
      expect(ansuRuleTokenValues({ level })["{{ansuTempHp}}"]).toBe(tempHpFor(1));
    }
    expect(ansuRuleTokenValues(null)["{{ansuTempHp}}"]).toBe(tempHpFor(1));
  });

  it("substitutes a number when the value IS the token, a string when it is embedded", () => {
    const subs = ansuRuleTokenValues({ level: 7 });
    expect(ansuScrubbedValue("{{ansuTempHp}}", subs)).toBe(21);
    expect(ansuScrubbedValue("gain {{ansuTempHp}} temp HP", subs)).toBe("gain 21 temp HP");
    expect(ansuScrubbedValue("{{ansuResist}} and {{ansuTierDice}}", subs)).toBe("4 and 3");
  });

  it("passes untouched anything with no token in it", () => {
    const subs = ansuRuleTokenValues({ level: 1 });
    expect(ansuScrubbedValue("melee-strike-damage", subs)).toBe("melee-strike-damage");
    expect(ansuScrubbedValue(3, subs)).toBe(3);
    expect(ansuScrubbedValue(null, subs)).toBeNull();
    expect(ansuScrubbedValue(undefined, subs)).toBeUndefined();
    expect(ansuScrubbedValue(true, subs)).toBe(true);
  });

  it("spots a token that survived a scrub and a prose @Check dc", () => {
    expect(packSourceTextProblems("x.json", '{"value":"{{ansuTempHp}}"}')[0]).toContain("unresolved {{token}}");
    expect(packSourceTextProblems("x.json", "@Check[will|dc:your Release DC]")[0]).toContain("malformed inline @Check dc");
    expect(packSourceTextProblems("x.json", "@Check[will|dc:30]")).toEqual([]);
    expect(packSourceTextProblems("x.json", "@Check[will|dc:]")).toEqual([]);
  });

  it("catches a document baked at the wrong level, and a missing one", () => {
    const one = { entries: [{ id: "v", level: 7, rules: [{ key: "TempHP", value: "{{ansuTempHp}}" }] }] };
    const wrong = [{ flags: { "the-shards-subsystems": { ansuPack: { entryId: "v" } } }, system: { rules: [{ key: "TempHP", value: 3 }] } }];
    expect(ansuBakedNumberProblems(one, wrong)[0]).toContain("expected 21 at attunement 7");
    expect(ansuBakedNumberProblems(one, [])[0]).toContain("missing, but its rules carry a number token");
  });

  it("ignores entries whose rules carry no token", () => {
    const clean = { entries: [{ id: "q", level: 3, rules: [{ key: "FlatModifier", value: 2 }] }] };
    expect(ansuRulesCarryTokens(clean.entries[0])).toBe(false);
    expect(ansuBakedNumberProblems(clean, [])).toEqual([]);
    expect(ansuBakedNumberProblems({}, [])).toEqual([]);
    expect(ansuBakedNumberProblems(null, null)).toEqual([]);
  });
});
