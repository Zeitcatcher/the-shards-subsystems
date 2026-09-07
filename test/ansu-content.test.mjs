import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent, indexContent } from "../src/subsystems/ansu/content.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(ROOT, "data/ansu/content.json"), "utf8"));

describe("data/ansu/content.json", () => {
  it("passes the runtime schema validation", () => {
    expect(validateContent(raw)).toEqual([]);
  });
  it("indexes with unique ids and family groups", () => {
    const idx = indexContent(raw);
    expect(idx.byId.size).toBe(raw.entries.length);
    expect(idx.byFamily.get("ancestral-vigor")).toHaveLength(2); // rank 1 + Union upgrade
  });
  it("covers the approved ladder: every level 1..9 has at least one entry, 10 is gated", () => {
    for (let lvl = 1; lvl <= 9; lvl += 1) {
      expect(raw.entries.some((e) => e.level === lvl && !e.gate)).toBe(true);
    }
    const tens = raw.entries.filter((e) => e.level === 10);
    expect(tens.length).toBeGreaterThan(0);
    expect(tens.every((e) => e.gate === "subjugated")).toBe(true);
  });
  it("ships the rev-3 ladder: 21 entries, five GM-approved new actives", () => {
    expect(raw.entries).toHaveLength(21);
    for (const id of ["makers-wrath", "fair-battle", "salbarine-parry", "hurl-the-blade", "the-ansu-refuses"]) {
      expect(raw.entries.some((e) => e.id === id && e.form === "action")).toBe(true);
    }
  });
  it("keeps the Inheritance line thin: always-on entries are bonus feats", () => {
    const always = raw.entries.filter((e) => e.always);
    expect(always.map((e) => e.id).sort()).toEqual(["engineers-eye", "tongue-of-the-makers"]);
    expect(always.every((e) => e.form === "feat")).toBe(true);
  });
  it("only Invoke stays on the sheet while dormant", () => {
    const doors = raw.entries.filter((e) => e.actionData?.alwaysAvailable);
    expect(doors.map((e) => e.id)).toEqual(["invoke-the-ansu"]);
  });
  it("Invoke carries the Call gate (Intimidation, {{ansuCallDC}}, four outcomes)", () => {
    const invoke = raw.entries.find((e) => e.id === "invoke-the-ansu");
    expect(invoke.description).toContain("{{ansuCallDC}}");
    expect(invoke.description).toContain("Intimidation");
    expect(invoke.description).toContain("Critical Failure");
  });
  it("per-communion actives carry the frequency the module resets", () => {
    const per = raw.entries.filter((e) => e.actionData?.perCommunion);
    expect(per.map((e) => e.id)).toEqual(["roar-of-the-old-blood"]);
    expect(per[0].actionData.frequency).toEqual({ max: 1, per: "day" });
  });
  it("The Ansu Refuses runs the module-owned 10-minute cooldown", () => {
    const refuses = raw.entries.find((e) => e.id === "the-ansu-refuses");
    expect(refuses.actionData.cooldownMinutes).toBe(10);
    // per "PT10M" so the sheet reads "once every 10 minutes", matching the cooldown (D3).
    expect(refuses.actionData.frequency).toEqual({ max: 1, per: "PT10M" });
    expect(refuses.actionData.actionType).toBe("reaction");
  });
  it("Maker's Wrath and Fair Battle carry the Furious Strike toggle-damage pattern", () => {
    const wrath = raw.entries.find((e) => e.id === "makers-wrath");
    expect(wrath.rules.map((r) => r.key)).toEqual(["RollOption", "DamageDice"]);
    expect(wrath.rules[0]).toMatchObject({ domain: "melee-strike-damage", option: "makers-wrath", toggleable: true });
    expect(wrath.rules[1]).toMatchObject({ selector: "melee-strike-damage", diceNumber: "{{ansuTierDice}}", dieSize: "d6", predicate: ["makers-wrath"] });
    expect(wrath.rules[1].damageType).toBeUndefined(); // omitted = the weapon's own type

    const fair = raw.entries.find((e) => e.id === "fair-battle");
    expect(fair.rules.map((r) => r.key)).toEqual(["RollOption", "FlatModifier"]);
    expect(fair.rules[0]).toMatchObject({ option: "fair-battle", toggleable: true });
    expect(fair.rules[1]).toMatchObject({ selector: "melee-strike-damage", value: 10, predicate: ["fair-battle"] });
  });
  it("Stature has no size change — reach rides a Note rule", () => {
    const stature = raw.entries.find((e) => e.id === "ansus-stature");
    expect(stature.rules.some((r) => r.key === "CreatureSize")).toBe(false);
    expect(stature.rules.some((r) => r.key === "Note")).toBe(true);
  });
  it("condition links are ID-based — names only resolve in pf2e's own compiled packs", () => {
    const all = JSON.stringify(raw);
    for (const m of all.matchAll(/conditionitems\.Item\.([A-Za-z0-9]+)/g)) {
      expect(m[1], `name-based condition link: ${m[0]}`).toMatch(/^[A-Za-z0-9]{16}$/);
    }
  });
  it("Mastery's free-action Invoke lives on the Invoke entry alone", () => {
    const withOverride = raw.entries.filter((e) => e.terminalActionData);
    expect(withOverride.map((e) => e.id)).toEqual(["invoke-the-ansu"]);
    expect(withOverride[0].terminalActionData).toEqual({
      actionType: "free",
      actions: null,
      traits: ["concentrate"],
      frequency: { max: 1, per: "round" },
      alwaysAvailable: true,
    });
  });
  it("Roar of the Old Blood shifts the roller's degree, the way Demoralize resolves", () => {
    const roar = raw.entries.find((e) => e.id === "roar-of-the-old-blood");
    // pf2e 8.5.0 PF2E.Actions.Demoralize.Description: one Intimidation check vs the
    // target's Will DC, crit success Frightened 2, success Frightened 1, and no
    // target-side roll at all — so there is no result for a target to worsen.
    expect(roar.description).toContain("one degree of success better");
    expect(roar.description).not.toContain("one degree of success worse");
    expect(roar.description).toContain("On a critical success");
    expect(roar.description).not.toContain("becomes a critical failure");
    // Both condition links survive the rewrite.
    expect(roar.description).toContain("TBSHQspnbcqxsmjL"); // Frightened
    expect(roar.description).toContain("sDPxOjQ9kx2RZE8D"); // Fleeing
  });
  it("icons avoid trees the hosted install lacks (playtest 2026-07-07)", () => {
    const banned = ["icons/abilities/", "icons/ancestries/", "worn-items/"];
    for (const e of raw.entries) {
      for (const tree of banned) {
        expect(e.img ?? "", `${e.id} uses banned icon tree ${tree}`).not.toContain(tree);
      }
    }
  });
});

/**
 * Every other Ansu content test feeds the real, valid file, so all of
 * validateContent's rejection branches ran zero times: a refactor that silenced
 * the validator kept the suite green. These drive one broken field at a time off
 * a valid base entry. (item 36)
 */
describe("validateContent rejects bad entries", () => {
  const OK = Object.freeze({
    id: "a", family: "fam-a", rank: 1, level: 1, kind: "boon", form: "effect", name: "A", rules: [],
  });
  /** Assert one problem, matching a distinctive substring of its message. */
  const only = (entry, needle) => {
    const problems = validateContent({ entries: [entry] });
    expect(problems, `expected exactly one problem, got ${JSON.stringify(problems)}`).toHaveLength(1);
    expect(problems[0]).toContain(needle);
  };

  it("rejects a root that is not an object", () => {
    expect(validateContent(null)).toEqual(["root is not an object"]);
    expect(validateContent("entries")).toEqual(["root is not an object"]);
    expect(validateContent(7)).toEqual(["root is not an object"]);
  });

  it("rejects a missing or non-array entries list", () => {
    expect(validateContent({})).toEqual(["`entries` is missing or not an array"]);
    expect(validateContent({ entries: "nope" })).toEqual(["`entries` is missing or not an array"]);
    expect(validateContent({ entries: {} })).toEqual(["`entries` is missing or not an array"]);
  });

  it("rejects entries that are not objects, one problem each", () => {
    const problems = validateContent({ entries: [null, 5, "x"] });
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.includes("not an object"))).toBe(true);
  });

  it("rejects a missing id", () => {
    const { id, ...noId } = OK;
    only(noId, "missing id");
    only({ ...OK, id: "" }, "missing id");
  });

  it("rejects a duplicate id", () => {
    const problems = validateContent({ entries: [OK, { ...OK, family: "fam-b" }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duplicate id");
    expect(problems[0]).toContain("entry[1]");
  });

  it("rejects a missing family", () => {
    const { family, ...noFamily } = OK;
    only(noFamily, "missing family");
    only({ ...OK, family: "" }, "missing family");
  });

  it("rejects a non-integer rank", () => {
    only({ ...OK, rank: 1.5 }, "rank must be an integer");
    only({ ...OK, rank: "1" }, "rank must be an integer");
  });

  it("rejects a level outside 0..10", () => {
    only({ ...OK, level: 11 }, "level must be 0..10");
    only({ ...OK, level: -1 }, "level must be 0..10");
    only({ ...OK, level: 2.5 }, "level must be 0..10");
  });

  it("rejects an unknown kind", () => {
    only({ ...OK, kind: "bane" }, "kind must be boon");
  });

  it("rejects an unknown form", () => {
    only({ ...OK, form: "spell" }, "form must be effect|action|strike");
  });

  it("rejects a gate other than subjugated", () => {
    only({ ...OK, gate: "taken" }, 'gate must be omitted or "subjugated"');
  });

  it("rejects a missing name", () => {
    only({ ...OK, name: "" }, "missing name");
  });

  it("rejects non-array rules", () => {
    only({ ...OK, rules: {} }, "rules must be an array");
    only({ ...OK, rules: "none" }, "rules must be an array");
  });

  it("rejects a non-boolean always", () => {
    only({ ...OK, form: "feat", always: "yes" }, "always must be a boolean");
  });

  it("rejects always on a non-feat form", () => {
    only({ ...OK, always: true }, "always-on entries must be feat-form");
  });

  it("rejects a feat form without always", () => {
    only({ ...OK, form: "feat" }, "set always: true");
  });

  it("rejects an action form with no actionData", () => {
    only({ ...OK, form: "action" }, "action form needs actionData");
  });

  it("rejects a strike form with no strikeData", () => {
    only({ ...OK, form: "strike" }, "strike form needs strikeData");
    only({ ...OK, form: "strike", strikeData: "d8" }, "strike form needs strikeData");
  });

  it("rejects perCommunion without a frequency", () => {
    only({ ...OK, form: "action", actionData: { perCommunion: true } }, "perCommunion needs a frequency");
  });

  it("rejects a non-boolean perCommunion, and still misses no frequency behind it", () => {
    // "yes" is truthy, so both branches fire: the type problem and the missing frequency.
    const problems = validateContent({ entries: [{ ...OK, form: "action", actionData: { perCommunion: "yes" } }] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("actionData.perCommunion must be a boolean");
    expect(problems[1]).toContain("perCommunion needs a frequency");
  });

  it("rejects cooldownMinutes without a frequency", () => {
    only({ ...OK, form: "action", actionData: { cooldownMinutes: 10 } }, "cooldownMinutes needs a frequency");
    only({ ...OK, form: "action", actionData: { cooldownMinutes: "10" } }, "actionData.cooldownMinutes must be an integer");
  });

  it("rejects a non-boolean alwaysAvailable", () => {
    only({ ...OK, form: "action", actionData: { alwaysAvailable: 1 } }, "actionData.alwaysAvailable must be a boolean");
  });

  it("rejects a non-string chipTag", () => {
    only({ ...OK, chipTag: 3 }, "chipTag must be a string");
  });

  // item 13: composeActions swaps terminalActionData in wholesale for a
  // subjugated master, so it needs the same type checks actionData gets.
  it("holds terminalActionData to the actionData rules", () => {
    only({ ...OK, form: "action", actionData: {}, terminalActionData: [] }, "terminalActionData must be an object");
    only(
      { ...OK, form: "action", actionData: {}, terminalActionData: { alwaysAvailable: "yes" } },
      "terminalActionData.alwaysAvailable must be a boolean",
    );
    only(
      { ...OK, form: "action", actionData: {}, terminalActionData: { perCommunion: true } },
      "terminalActionData perCommunion needs a frequency",
    );
    only(
      { ...OK, form: "action", actionData: {}, terminalActionData: { cooldownMinutes: 10 } },
      "terminalActionData cooldownMinutes needs a frequency",
    );
  });

  it("rejects terminalActionData on anything but an action", () => {
    only({ ...OK, terminalActionData: { actionType: "free" } }, "terminalActionData only applies to action form");
  });

  // item 35: selectEntries picks a family's live entry with a strict `>` on rank,
  // so a tie silently drops the loser and its rules, and the build's own guard
  // only compares _ids.
  it("rejects two entries sharing a family and a rank", () => {
    const problems = validateContent({ entries: [OK, { ...OK, id: "b", name: "B" }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duplicate family/rank (fam-a rank 1)");
  });

  it("accepts a family whose ranks differ (the real upgrade shape)", () => {
    expect(validateContent({ entries: [OK, { ...OK, id: "b", rank: 2, level: 7, name: "B" }] })).toEqual([]);
  });

  it("reports a problem raised by a later entry, not just the first", () => {
    const entries = [
      OK,
      { ...OK, id: "b", family: "fam-b", name: "B" },
      { ...OK, id: "c", family: "fam-c", name: "C" },
      { ...OK, id: "a", family: "fam-d", name: "D" },
    ];
    const problems = validateContent({ entries });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("entry[3] (a)");
    expect(problems[0]).toContain("duplicate id");
  });

  it("indexContent throws with every problem listed", () => {
    expect(() => indexContent({ entries: [{}] })).toThrow(/Ansu content invalid/);
    expect(() => indexContent(null)).toThrow(/root is not an object/);
    expect(() => indexContent({ entries: [OK] })).not.toThrow();
  });
});
