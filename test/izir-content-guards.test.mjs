import { describe, it, expect } from "vitest";
import { validateContent } from "../src/subsystems/izir/content.mjs";

/**
 * The validator's negative branches had no coverage at all, and several authoring
 * mistakes went through it silently: a form the composer has no branch for, rules
 * on an action entry that only the pack copy would keep, a hyphenated 16-character
 * id that can never resolve as a document id, a recharge formula that fails at the
 * table, and an aura pointing somewhere other than the effect it declares. (F31)
 */
const base = {
  id: "x",
  family: "x",
  rank: 1,
  level: 1,
  kind: "boon",
  form: "effect",
  name: "X",
  description: "<p>.</p>",
  rules: [],
};

const check = (over = {}, extra = {}) => validateContent({ entries: [{ ...base, ...over }], ...extra });
const complains = (problems, needle) => problems.some((p) => p.includes(needle));

describe("content validation refuses what it used to wave through", () => {
  it("accepts a well-formed entry", () => {
    expect(check()).toEqual([]);
  });

  it("names every real form in the message, strike included", () => {
    const problems = check({ form: "wrong" });
    expect(complains(problems, "effect|action|strike")).toBe(true);
  });

  it("rejects the spell form until there is a spell path to build", () => {
    // It used to validate and then do nothing: the composer has no branch for it.
    expect(complains(check({ form: "spell", spellData: {} }), "form must be")).toBe(true);
  });

  it("rejects rules on an action entry", () => {
    const problems = check({
      form: "action",
      actionData: { actionType: "action", actions: 1 },
      rules: [{ key: "FlatModifier", selector: "athletics", value: 1 }],
    });
    expect(complains(problems, "cannot carry rules")).toBe(true);
  });

  it("rejects a recharge that is not a die formula", () => {
    const good = check({ form: "action", actionData: { actionType: "action", actions: 1, recharge: "1d6" } });
    expect(good).toEqual([]);
    expect(complains(check({ form: "action", actionData: { recharge: "1da" } }), "die formula")).toBe(true);
    expect(complains(check({ form: "action", actionData: { recharge: "2d6+1" } }), "die formula")).toBe(false);
  });

  it("rejects a strike entry with no strikeData", () => {
    expect(complains(check({ form: "strike" }), "needs strikeData")).toBe(true);
  });

  it("rejects a pack effect id that is not 16 letters and digits", () => {
    const packEffects = [{ _id: "izir-terror-0001", name: "Bad" }];
    expect(complains(validateContent({ entries: [], packEffects }), "letters and digits")).toBe(true);
  });

  it("makes auraEffectId and the Aura rule name the same document", () => {
    const packEffects = [{ _id: "izirterroraura00", name: "Aura" }];
    const aura = (uuid) => ({
      ...base,
      auraEffectId: "izirterroraura00",
      rules: [{ key: "Aura", slug: "a", radius: 10, effects: [{ uuid }] }],
    });

    expect(validateContent({ entries: [aura("{{izirPack:izirterroraura00}}")], packEffects })).toEqual([]);
    expect(
      complains(
        validateContent({ entries: [aura("Compendium.the-shards-subsystems.izir-effects.Item.izirterroraura00")], packEffects }),
        "should be",
      ),
    ).toBe(true);
    expect(
      complains(
        validateContent({ entries: [{ ...base, auraEffectId: "izirterroraura00" }], packEffects }),
        "no Aura rule references it",
      ),
    ).toBe(true);
  });

  it("still catches the basics", () => {
    expect(complains(check({ id: "" }), "missing id")).toBe(true);
    expect(complains(check({ kind: "curse" }), "boon|bane")).toBe(true);
    expect(complains(check({ level: 11 }), "level must be 0..10")).toBe(true);
    expect(complains(check({ gate: "nineveh" }), "gate must be")).toBe(true);
    expect(complains(validateContent({ entries: [base, base] }), "duplicate id")).toBe(true);
  });
});
