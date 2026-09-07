import { describe, it, expect } from "vitest";
import {
  selectEntries,
  buildCtx,
  injectNumbers,
  durationLabel,
  communionMode,
  doorsDead,
  costGlyph,
  frequencyTag,
  actionDataFor,
  ladderCtxLevel,
  composeAttunement,
  composeCommunion,
  composeActions,
  composeFeats,
  diffAll,
  suppressCreateGrants,
  carriedTempFor,
  tempRestoreValue,
  ATTUNEMENT_ENTRY_ID,
  COMMUNION_ENTRY_ID,
} from "../src/subsystems/ansu/logic/reconcile.mjs";

/** Compact fixture mirroring the real content's shapes (rev 3). */
const CONTENT = {
  entries: [
    { id: "invoke", family: "invoke", rank: 1, level: 1, kind: "boon", form: "action", name: "Invoke",
      actionData: { actionType: "action", actions: 1, frequency: { max: 1, per: "round" }, alwaysAvailable: true }, rules: [] },
    { id: "wrath", family: "wrath", rank: 1, level: 1, kind: "boon", form: "action", name: "Wrath",
      description: "<p>+{{ansuTierDice}}d6.</p>", actionData: { actionType: "action", actions: 2 },
      rules: [
        { key: "RollOption", domain: "melee-strike-damage", option: "wrath", toggleable: true },
        { key: "DamageDice", selector: "melee-strike-damage", diceNumber: "{{ansuTierDice}}", dieSize: "d6", predicate: ["wrath"] },
      ] },
    { id: "vigor", family: "vigor", rank: 1, level: 1, kind: "boon", form: "effect", name: "Vigor",
      description: "<p>{{ansuTempHp}} temp HP.</p>",
      rules: [{ key: "TempHP", value: "{{ansuTempHp}}" }, { key: "FlatModifier", selector: "melee-strike-damage", type: "status", value: 2 }] },
    { id: "tongue", family: "tongue", rank: 1, level: 2, kind: "boon", form: "feat", always: true, name: "Tongue",
      rules: [{ key: "Note", selector: "all", title: "Tongue", text: "Knows Murkhor." }] },
    { id: "horns", family: "horns", rank: 1, level: 4, kind: "boon", form: "strike", name: "Horns",
      rules: [], strikeData: { die: "d10", damageType: "piercing" } },
    { id: "skin", family: "skin", rank: 1, level: 5, kind: "boon", form: "effect", name: "Skin",
      rules: [{ key: "Resistance", type: "physical", value: "{{ansuResist}}" }] },
    { id: "refuses", family: "refuses", rank: 1, level: 7, kind: "boon", form: "action", name: "Refuses",
      actionData: { actionType: "reaction", actions: null, frequency: { max: 1, per: "day" }, cooldownMinutes: 10 }, rules: [] },
    { id: "vigor-2", family: "vigor", rank: 2, level: 7, kind: "boon", form: "effect", name: "Vigor (Union)",
      rules: [{ key: "TempHP", value: "{{ansuTempHp}}" }, { key: "FlatModifier", selector: "melee-strike-damage", type: "status", value: 3 }] },
    { id: "capstone", family: "capstone", rank: 1, level: 10, kind: "boon", form: "action", gate: "subjugated",
      name: "Capstone", actionData: { actionType: "action", actions: 1 }, rules: [] },
  ],
};

const state = (over = {}) => ({
  enabled: true, level: 0, climb: 0, terminal: null, suppressed: [],
  communion: { mode: "none", rounds: null }, pendingRelease: null, seizure: null, cooldowns: [], log: [], ...over,
});

describe("selectEntries", () => {
  it("unlocks by level, highest rank per family wins", () => {
    const low = selectEntries(state({ level: 2 }), CONTENT);
    expect(low.live.map((e) => e.id)).toEqual(["invoke", "vigor", "wrath", "tongue"]);
    const high = selectEntries(state({ level: 8 }), CONTENT);
    expect(high.live.map((e) => e.id)).toContain("vigor-2");
    expect(high.live.map((e) => e.id)).not.toContain("vigor");
    expect(high.replacedIds).toContain("vigor");
  });
  it("keeps the gate closed until Mastery, and open for terminals", () => {
    expect(selectEntries(state({ level: 9 }), CONTENT).live.map((e) => e.id)).not.toContain("capstone");
    expect(selectEntries(state({ level: 10, terminal: "subjugated" }), CONTENT).live.map((e) => e.id)).toContain("capstone");
    expect(selectEntries(state({ level: 10, terminal: "taken" }), CONTENT).live.map((e) => e.id)).toContain("capstone");
  });
  it("unlockAll (seizure) opens every level and the gate", () => {
    const all = selectEntries(state({ level: 1 }), CONTENT, { unlockAll: true });
    expect(all.live.map((e) => e.id)).toEqual(expect.arrayContaining(["vigor-2", "horns", "skin", "capstone"]));
  });
  it("drops suppressed families", () => {
    const s = selectEntries(state({ level: 2, suppressed: [{ id: "vigor", reason: "" }] }), CONTENT);
    expect(s.live.map((e) => e.id)).not.toContain("vigor");
  });
});

describe("numbers (rev 3)", () => {
  it("buildCtx bakes both DC ladders, temp HP 3×, resistance /2, parry, tier dice", () => {
    const ctx = buildCtx(4, 4);
    expect(ctx.releaseDc).toBe(28);
    expect(ctx.callDc).toBe(28); // ladders match through 5…
    expect(buildCtx(8, 8).callDc).toBe(36); // …then the Call keeps climbing
    expect(buildCtx(8, 8).releaseDc).toBe(30);
    expect(ctx.tempHp).toBe(12);
    expect(ctx.resist).toBe(2);
    expect(ctx.parry).toBe(8);
    expect(ctx.tierDice).toBe(2);
    expect(ctx.durationRounds).toBe(3);
  });
  it("injects {{ansuCallDC}}", () => {
    expect(injectNumbers("Call DC {{ansuCallDC}}", buildCtx(4, 6))).toBe("Call DC 32");
  });
  it("injectNumbers replaces every token", () => {
    const ctx = buildCtx(4, 5);
    expect(injectNumbers(
      "DC {{ansuReleaseDC}}, {{ansuTempHp}} THP, res {{ansuResist}}, parry {{ansuParry}}, {{ansuTierDice}}d6, att {{ansuLevel}}, {{ansuDuration}}",
      ctx,
    )).toBe("DC 30, 15 THP, res 3, parry 10, 2d6, att 5, 3 rounds");
  });
  it("durationLabel names the bands", () => {
    expect(durationLabel(1)).toBe("1 round");
    expect(durationLabel(3)).toBe("3 rounds");
    expect(durationLabel(10)).toBe("1 minute");
    expect(durationLabel(null)).toBe("unlimited");
  });
});

describe("communionMode", () => {
  it("maps state to the composed mode", () => {
    expect(communionMode(state())).toBe("none");
    expect(communionMode(state({ communion: { mode: "active" } }))).toBe("active");
    expect(communionMode(state({ communion: { mode: "lingering" } }))).toBe("lingering");
    expect(communionMode(state({ communion: { mode: "seized" } }))).toBe("seized");
    expect(communionMode(state({ terminal: "subjugated", communion: { mode: "active" } }))).toBe("permanent");
    expect(communionMode(state({ terminal: "subjugated", communion: { mode: "none" } }))).toBe("off");
    expect(communionMode(state({ terminal: "taken", communion: { mode: "none" } }))).toBe("taken");
  });
});

describe("composeAttunement", () => {
  it("is null while untracked at level 0 and present from level 1", () => {
    expect(composeAttunement(state(), CONTENT, { charLevel: 4 })).toBeNull();
    const c = composeAttunement(state({ level: 1 }), CONTENT, { charLevel: 4 });
    expect(c.entryId).toBe(ATTUNEMENT_ENTRY_ID);
    expect(c.badge).toEqual({ value: 1, max: 9 });
  });
  it("is null when the marker world-setting is off", () => {
    expect(composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5, marker: false })).toBeNull();
  });
  it("carries ONLY roll options — inheritance rules moved to feats", () => {
    const c = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5 });
    expect(c.rules.map((r) => r.key)).toEqual(["RollOption", "RollOption", "RollOption"]);
    expect(c.inheritanceLines.map((l) => l.name)).toEqual(["Tongue"]);
  });
  it("terminal badge runs to 10", () => {
    const c = composeAttunement(state({ level: 10, terminal: "subjugated" }), CONTENT, { charLevel: 8 });
    expect(c.badge).toEqual({ value: 10, max: 10 });
    expect(c.tier).toBe("subjugated");
  });

  // The marker's description quotes the Release DC, but nothing else in the hash
  // moves when a DC dial does, so syncAllAttuned found no drift and the same
  // sheet ended up quoting two different DCs. (item 27)
  it("re-hashes when a DC dial moves, so the quoted Release DC can't go stale", () => {
    const at20 = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5, dials: { dcBase: 20 } });
    const at24 = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5, dials: { dcBase: 24 } });
    expect(at24.releaseDc).not.toBe(at20.releaseDc);
    expect(at24.hash).not.toBe(at20.hash);
  });
  it("still hashes the same for the same dials", () => {
    const a = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5, dials: { dcBase: 20 } });
    const b = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5, dials: { dcBase: 20 } });
    expect(b.hash).toBe(a.hash);
  });
});

describe("composeFeats", () => {
  it("materializes feat-form Inheritance once unlocked, independent of Communion", () => {
    expect(composeFeats(state({ level: 1 }), CONTENT, { charLevel: 4 })).toHaveLength(0);
    const feats = composeFeats(state({ level: 2 }), CONTENT, { charLevel: 4 });
    expect(feats.map((f) => f.entryId)).toEqual(["tongue"]);
    expect(feats[0].kind).toBe("feat");
    expect(feats[0].rules.map((r) => r.key)).toEqual(["Note"]);
    expect(feats[0].level).toBe(2);
  });
  it("survives dormancy — knowledge stays while the power sleeps", () => {
    const dormant = composeFeats(state({ level: 5, communion: { mode: "none" } }), CONTENT, { charLevel: 5 });
    expect(dormant.map((f) => f.entryId)).toEqual(["tongue"]);
  });
});

describe("composeCommunion", () => {
  it("is null while dormant and while a master toggled off", () => {
    expect(composeCommunion(state({ level: 3 }), CONTENT, { charLevel: 4 })).toBeNull();
    expect(composeCommunion(state({ terminal: "subjugated", level: 10, communion: { mode: "none" } }), CONTENT, { charLevel: 8 })).toBeNull();
  });
  it("active carries the non-feat boon rules, the strike RE, and injected numbers", () => {
    const c = composeCommunion(state({ level: 5, communion: { mode: "active", rounds: 3 } }), CONTENT, { charLevel: 5 });
    expect(c.entryId).toBe(COMMUNION_ENTRY_ID);
    expect(c.mode).toBe("active");
    expect(c.durationRounds).toBe(3);
    const keys = c.rules.map((r) => r.key);
    expect(keys).toContain("TempHP");
    expect(keys).toContain("Strike"); // horns
    expect(keys).toContain("Resistance");
    expect(keys).not.toContain("Note"); // inheritance lives on the feats
    const resist = c.rules.find((r) => r.key === "Resistance");
    expect(resist.value).toBe(3); // ⌈5/2⌉ baked to a NUMBER
    const temp = c.rules.find((r) => r.key === "TempHP");
    expect(temp.value).toBe(15); // 3 × 5
  });
  it("seizure composes at full strength regardless of level", () => {
    const c = composeCommunion(state({ level: 1, communion: { mode: "seized" } }), CONTENT, { charLevel: 4 });
    expect(c.level).toBe(10);
    const damage = c.rules.filter((r) => r.key === "FlatModifier" && r.selector === "melee-strike-damage");
    expect(damage).toHaveLength(1);
    expect(damage[0].value).toBe(3); // vigor rank 2 shadowed rank 1
  });
  it("permanent (Mastery) and taken never expire", () => {
    const master = composeCommunion(state({ level: 10, terminal: "subjugated", communion: { mode: "active" } }), CONTENT, { charLevel: 9 });
    expect(master.permanent).toBe(true);
    expect(master.durationRounds).toBeNull();
    const taken = composeCommunion(state({ level: 10, terminal: "taken", communion: { mode: "none" } }), CONTENT, { charLevel: 9 });
    expect(taken.permanent).toBe(true);
    expect(taken.mode).toBe("taken");
  });
  it("carries the seizure return's clock stamp through WITHOUT hashing it", () => {
    const plain = composeCommunion(state({ level: 5, communion: { mode: "active", rounds: 3 } }), CONTENT, { charLevel: 5 });
    const stamped = composeCommunion(
      state({ level: 5, communion: { mode: "active", rounds: 3, startAt: 126 } }),
      CONTENT,
      { charLevel: 5 },
    );
    expect(plain.startAt).toBeNull();
    expect(stamped.startAt).toBe(126);
    // a clock instruction is not content: the same items must not churn for it
    expect(stamped.hash).toBe(plain.hash);
  });
  it("ignores a junk clock stamp", () => {
    for (const startAt of ["126", null, undefined, Number.NaN, Infinity]) {
      const c = composeCommunion(state({ level: 5, communion: { mode: "active", rounds: 3, startAt } }), CONTENT, { charLevel: 5 });
      expect(c.startAt).toBeNull();
    }
  });
});

/**
 * The expiry rebuild. With pf2e's removeExpiredEffects on, an expiring Communion
 * is DELETED and re-created, pf2e runs every rule's onCreate on the new item, and
 * the bearer was handed a whole fresh pool of temporary Hit Points at the exact
 * moment the buff was supposed to run out. With the automation off the same
 * transition is an in-place update that grants nothing, so one pf2e setting
 * changed the rules.
 */
describe("suppressCreateGrants", () => {
  it("switches off TempHP's create-time grant but keeps the rule on the item", () => {
    const out = suppressCreateGrants([{ key: "TempHP", value: 15 }]);
    // the rule has to stay: pf2e's onDelete is what clears the pool at the end
    expect(out[0].key).toBe("TempHP");
    expect(out[0].value).toBe(15);
    expect(out[0].events).toEqual({ onCreate: false, onTurnStart: false });
  });

  it("leaves the data-prep rules alone and never mutates its input", () => {
    const rules = [
      { key: "FlatModifier", selector: "melee-strike-damage", type: "status", value: 2 },
      { key: "Resistance", type: "physical", value: 3 },
      { key: "TempHP", value: 15 },
    ];
    const out = suppressCreateGrants(rules);
    expect(out[0]).toEqual(rules[0]);
    expect(out[1]).toEqual(rules[1]);
    expect(rules[2].events).toBeUndefined();
  });

  it("is a no-op when nothing grants on create", () => {
    const rules = [{ key: "Resistance", type: "physical", value: 3 }];
    expect(suppressCreateGrants(rules)).toBe(rules);
  });

  it("survives junk input", () => {
    expect(suppressCreateGrants()).toEqual([]);
    expect(suppressCreateGrants(null)).toEqual([]);
    expect(suppressCreateGrants([null, { key: "TempHP", value: 3 }])[1].events.onCreate).toBe(false);
  });
});

describe("composeCommunion — expiry rebuild", () => {
  const active = state({ level: 5, communion: { mode: "active", rounds: 3 } });

  it("grants normally when nothing is being rebuilt", () => {
    const temp = composeCommunion(active, CONTENT, { charLevel: 5 }).rules.find((r) => r.key === "TempHP");
    expect(temp.value).toBe(15);
    expect(temp.events).toBeUndefined(); // pf2e's own default is onCreate true
  });

  it("suppresses only the create-time grant on a rebuild", () => {
    const c = composeCommunion(active, CONTENT, { charLevel: 5, rebuild: true });
    const temp = c.rules.find((r) => r.key === "TempHP");
    expect(temp.events).toEqual({ onCreate: false, onTurnStart: false });
    expect(temp.value).toBe(15);
    expect(c.rules.find((r) => r.key === "Resistance").value).toBe(3);
    expect(c.rules.filter((r) => r.key === "FlatModifier")).toHaveLength(1);
    expect(c.rules.some((r) => r.key === "Strike")).toBe(true);
  });

  it("hashes the suppression, so the next ordinary sync flips it back", () => {
    const plain = composeCommunion(active, CONTENT, { charLevel: 5 });
    const rebuilt = composeCommunion(active, CONTENT, { charLevel: 5, rebuild: true });
    expect(rebuilt.hash).not.toBe(plain.hash);
  });

  it("rebuilds a lingering Communion the same way", () => {
    const c = composeCommunion(state({ level: 5, communion: { mode: "lingering" } }), CONTENT, {
      charLevel: 5,
      rebuild: true,
    });
    expect(c.rules.find((r) => r.key === "TempHP").events.onCreate).toBe(false);
  });
});

describe("carriedTempFor", () => {
  it("carries the pool when our own item is the source", () => {
    expect(carriedTempFor({ temp: 8, tempsource: "i1", itemId: "i1" })).toBe(8);
  });

  it("carries nothing another effect granted", () => {
    expect(carriedTempFor({ temp: 20, tempsource: "other", itemId: "i1" })).toBe(0);
    expect(carriedTempFor({ temp: 20, tempsource: undefined, itemId: "i1" })).toBe(0);
  });

  it("is 0 for a spent, negative, junk or unidentifiable pool", () => {
    expect(carriedTempFor({ temp: 0, tempsource: "i1", itemId: "i1" })).toBe(0);
    expect(carriedTempFor({ temp: -3, tempsource: "i1", itemId: "i1" })).toBe(0);
    expect(carriedTempFor({ temp: "x", tempsource: "i1", itemId: "i1" })).toBe(0);
    expect(carriedTempFor({ temp: 8, tempsource: "i1" })).toBe(0);
    expect(carriedTempFor()).toBe(0);
  });
});

describe("tempRestoreValue", () => {
  it("puts back what was LEFT of a partly spent pool", () => {
    expect(tempRestoreValue({ carried: 8, live: 0 })).toBe(8);
  });

  it("never stacks: a bigger pool from anywhere else wins", () => {
    expect(tempRestoreValue({ carried: 8, live: 20 })).toBeNull();
    expect(tempRestoreValue({ carried: 8, live: 8 })).toBeNull();
  });

  it("never resurrects a spent pool and never writes junk", () => {
    expect(tempRestoreValue({ carried: 0, live: 0 })).toBeNull();
    expect(tempRestoreValue({ carried: -5, live: 0 })).toBeNull();
    expect(tempRestoreValue({ carried: "x", live: 0 })).toBeNull();
    expect(tempRestoreValue({ carried: 8, live: "junk" })).toBe(8);
    expect(tempRestoreValue()).toBeNull();
  });
});

describe("composeActions — communion gating", () => {
  it("dormant: only alwaysAvailable (the Invoke door) exists", () => {
    const acts = composeActions(state({ level: 5 }), CONTENT, { charLevel: 5 });
    expect(acts.map((a) => a.entryId)).toEqual(["invoke"]);
  });
  it("running Communion materializes every unlocked active", () => {
    const acts = composeActions(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
    expect(acts.map((a) => a.entryId).sort()).toEqual(["invoke", "wrath"]);
  });
  it("lingering keeps the actives on (the boons haven't left)", () => {
    const acts = composeActions(state({ level: 5, communion: { mode: "lingering" } }), CONTENT, { charLevel: 5 });
    expect(acts.map((a) => a.entryId)).toContain("wrath");
  });
  it("seizure unlocks every active including the gate", () => {
    const acts = composeActions(state({ level: 1, communion: { mode: "seized" } }), CONTENT, { charLevel: 4 });
    expect(acts.map((a) => a.entryId)).toEqual(expect.arrayContaining(["invoke", "wrath", "refuses", "capstone"]));
  });
});

/**
 * At the Taken terminal both doors are dead: `requestInvoke` returns on
 * `terminal === "taken"` and `callRelease` on any terminal, both in silence,
 * while pf2e still spent the 1/round frequency on the Use. `door: true` marks
 * them in the content so the composer can drop them. (item 12)
 */
describe("dead doors at the Taken terminal", () => {
  const DOORS = {
    entries: [
      { id: "invoke-the-ansu", family: "invoke-the-ansu", rank: 1, level: 1, kind: "boon", form: "action", door: true,
        name: "Invoke the Ansu", rules: [],
        actionData: { actionType: "action", actions: 1, frequency: { max: 1, per: "round" }, alwaysAvailable: true } },
      { id: "release-the-ansu", family: "release-the-ansu", rank: 1, level: 1, kind: "boon", form: "action", door: true,
        name: "Release the Ansu", rules: [],
        actionData: { actionType: "free", actions: null, frequency: { max: 1, per: "round" } } },
      { id: "wrath", family: "wrath", rank: 1, level: 1, kind: "boon", form: "action", name: "Wrath",
        actionData: { actionType: "action", actions: 2 }, rules: [] },
      { id: "capstone", family: "capstone", rank: 1, level: 10, kind: "boon", form: "action", gate: "subjugated",
        name: "Capstone", actionData: { actionType: "action", actions: 1 }, rules: [] },
    ],
  };
  const taken = state({ level: 10, terminal: "taken", communion: { mode: "active" } });
  const subjugated = state({ level: 10, terminal: "subjugated", communion: { mode: "active" } });

  it("drops both door items from a Taken sheet and keeps the rest", () => {
    const ids = composeActions(taken, DOORS, { charLevel: 10 }).map((a) => a.entryId);
    expect(ids).not.toContain("invoke-the-ansu");
    expect(ids).not.toContain("release-the-ansu");
    expect(ids).toEqual(expect.arrayContaining(["wrath", "capstone"]));
  });

  it("stops the Taken Communion effect listing them as available abilities", () => {
    const names = composeCommunion(taken, DOORS, { charLevel: 10 }).abilityLines.map((a) => a.name);
    expect(names).not.toContain("Invoke the Ansu");
    expect(names).not.toContain("Release the Ansu");
    expect(names).toContain("Wrath");
  });

  it("leaves a subjugated master both doors: Mastery is played through them", () => {
    const ids = composeActions(subjugated, DOORS, { charLevel: 10 }).map((a) => a.entryId);
    expect(ids).toEqual(expect.arrayContaining(["invoke-the-ansu", "release-the-ansu", "capstone"]));
  });

  it("leaves an ordinary bearer alone at every mode", () => {
    for (const communion of [{ mode: "none" }, { mode: "active" }, { mode: "lingering" }, { mode: "seized" }]) {
      const ids = composeActions(state({ level: 5, communion }), DOORS, { charLevel: 5 }).map((a) => a.entryId);
      expect(ids).toContain("invoke-the-ansu");
    }
  });
});

/**
 * Mastery's capstone promises entering and leaving Communion as a free action,
 * and Release was authored that way, but composeActions copied `actionData`
 * verbatim at every state, so a subjugated master's Invoke still cost 1 action
 * and carried the concentrate glyph the capstone had just removed. (item 13)
 */
describe("actionDataFor — the Mastery free-action Invoke", () => {
  const invoke = {
    id: "invoke-the-ansu", family: "invoke-the-ansu", rank: 1, level: 1, kind: "boon", form: "action",
    door: true, name: "Invoke the Ansu", rules: [],
    actionData: { actionType: "action", actions: 1, traits: ["concentrate"], frequency: { max: 1, per: "round" }, alwaysAvailable: true },
    terminalActionData: { actionType: "free", actions: null, traits: ["concentrate"], frequency: { max: 1, per: "round" }, alwaysAvailable: true },
  };
  const wrath = { id: "wrath", family: "wrath", rank: 1, level: 1, kind: "boon", form: "action", name: "Wrath",
    actionData: { actionType: "action", actions: 2 }, rules: [] };
  const MASTERY = { entries: [invoke, wrath] };

  it("swaps in the override only for a subjugated master", () => {
    expect(actionDataFor(invoke, { terminal: "subjugated" }).actionType).toBe("free");
    expect(actionDataFor(invoke, { terminal: null }).actionType).toBe("action");
    expect(actionDataFor(invoke, { terminal: "taken" }).actionType).toBe("action");
  });

  it("falls back to actionData for an entry that authored no override", () => {
    expect(actionDataFor(wrath, { terminal: "subjugated" })).toBe(wrath.actionData);
  });

  it("survives junk input", () => {
    expect(actionDataFor(null, null)).toEqual({});
    expect(actionDataFor({}, { terminal: "subjugated" })).toEqual({});
    expect(actionDataFor(undefined, { terminal: "subjugated" })).toEqual({});
    expect(actionDataFor({ actionData: null }, undefined)).toEqual({});
  });

  it("puts the free action on a subjugated master's sheet", () => {
    const master = state({ level: 10, terminal: "subjugated", communion: { mode: "active" } });
    const inv = composeActions(master, MASTERY, { charLevel: 10 }).find((a) => a.entryId === "invoke-the-ansu");
    expect(inv.actionData.actionType).toBe("free");
    expect(inv.actionData.actions).toBeNull();
    expect(inv.actionData.traits).toEqual(["concentrate"]);
  });

  it("leaves the 1-action Invoke on every non-terminal bearer, level 9 included", () => {
    for (const lvl of [1, 5, 9]) {
      const st = state({ level: lvl, communion: { mode: "active" } });
      const inv = composeActions(st, MASTERY, { charLevel: lvl }).find((a) => a.entryId === "invoke-the-ansu");
      expect(inv.actionData.actionType).toBe("action");
      expect(inv.actionData.actions).toBe(1);
    }
  });

  it("keeps the dormant frequency refill reading the same block it wrote", () => {
    const dormant = state({ level: 10, terminal: "subjugated", communion: { mode: "none" } });
    const inv = composeActions(dormant, MASTERY, { charLevel: 10 }).find((a) => a.entryId === "invoke-the-ansu");
    expect(inv.actionData.actionType).toBe("free");
    expect(inv.actionData.frequencyValue).toBe(1);
  });

  it("makes the Communion effect's ability list agree with the item", () => {
    const master = state({ level: 10, terminal: "subjugated", communion: { mode: "active" } });
    const line = composeCommunion(master, MASTERY, { charLevel: 10 }).abilityLines.find((a) => a.name === "Invoke the Ansu");
    expect(line.glyph).toBe("◇");
    const ordinary = composeCommunion(state({ level: 9, communion: { mode: "active" } }), MASTERY, { charLevel: 9 })
      .abilityLines.find((a) => a.name === "Invoke the Ansu");
    expect(ordinary.glyph).toBe("◆");
  });
});

describe("composeActions — rule elements ride the action items", () => {
  it("forwards entry rules with number tokens baked (toggle-damage pattern)", () => {
    const acts = composeActions(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
    const wrath = acts.find((a) => a.entryId === "wrath");
    expect(wrath.rules.map((r) => r.key)).toEqual(["RollOption", "DamageDice"]);
    expect(wrath.rules[0].toggleable).toBe(true);
    expect(wrath.rules[1].diceNumber).toBe(2); // {{ansuTierDice}} baked to a NUMBER at Discipline
    expect(wrath.rules[1].predicate).toEqual(["wrath"]);
  });
  it("rules participate in the hash so a rules change updates the item", () => {
    const at5 = composeActions(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
    const at8 = composeActions(state({ level: 8, communion: { mode: "active" } }), CONTENT, { charLevel: 8 });
    const w5 = at5.find((a) => a.entryId === "wrath");
    const w8 = at8.find((a) => a.entryId === "wrath");
    expect(w5.hash).not.toBe(w8.hash); // tier dice 2 → 3 changes the baked rule
  });
});

describe("composeActions — module-owned cooldowns", () => {
  const running = (cooldowns, now) =>
    composeActions(state({ level: 7, communion: { mode: "active" }, cooldowns }), CONTENT, { charLevel: 8, now });

  it("zeroes the frequency while the cooldown runs and restores it after", () => {
    const cooling = running([{ id: "refuses", until: 1000 }], 400);
    expect(cooling.find((a) => a.entryId === "refuses").actionData.frequencyValue).toBe(0);
    const recovered = running([{ id: "refuses", until: 1000 }], 1000);
    expect(recovered.find((a) => a.entryId === "refuses").actionData.frequencyValue).toBe(1);
  });
  it("leaves ordinary frequencies unmanaged while Communion runs (pf2e owns their uses)", () => {
    const acts = running([], 0);
    expect(acts.find((a) => a.entryId === "invoke").actionData.frequencyValue).toBeUndefined();
  });
  it("restores the Invoke door's uses on every dormant resync (spent per-round frequencies never tick out of combat)", () => {
    const dormant = composeActions(state({ level: 5 }), CONTENT, { charLevel: 5, now: 0 });
    expect(dormant.find((a) => a.entryId === "invoke").actionData.frequencyValue).toBe(1);
  });
  it("cooldown state changes the hash so the sync updates the item", () => {
    const a = running([{ id: "refuses", until: 1000 }], 400).find((x) => x.entryId === "refuses");
    const b = running([{ id: "refuses", until: 1000 }], 1000).find((x) => x.entryId === "refuses");
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("diffAll", () => {
  const att = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5 });
  const comm = composeCommunion(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
  const feats = composeFeats(state({ level: 5 }), CONTENT, { charLevel: 5 });
  const acts = composeActions(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
  const desired = [att, comm, ...feats, ...acts];

  it("creates everything from scratch", () => {
    const { toCreate, toUpdate, toDeleteIds } = diffAll(desired, []);
    expect(toCreate).toHaveLength(desired.length);
    expect(toUpdate).toHaveLength(0);
    expect(toDeleteIds).toHaveLength(0);
  });
  it("is idempotent when hashes match and deletes strays (ending Communion deletes its actives)", () => {
    const tagged = desired.map((d, i) => ({ itemId: `i${i}`, entryId: d.entryId, contentHash: d.hash }));
    const clean = diffAll(desired, tagged);
    expect(clean.toCreate).toHaveLength(0);
    expect(clean.toUpdate).toHaveLength(0);
    // Communion ends: wrath/communion drop out of desired → their items get deleted.
    const dormantDesired = [att, ...feats, ...composeActions(state({ level: 5 }), CONTENT, { charLevel: 5 })];
    const afterEnd = diffAll(dormantDesired, tagged);
    const deletedEntryIds = tagged.filter((t) => afterEnd.toDeleteIds.includes(t.itemId)).map((t) => t.entryId);
    expect(deletedEntryIds.sort()).toEqual([COMMUNION_ENTRY_ID, "wrath"].sort());
  });
  it("updates in place on a hash change", () => {
    const tagged = [{ itemId: "a", entryId: att.entryId, contentHash: "stale" }];
    const { toUpdate } = diffAll([att], tagged);
    expect(toUpdate).toEqual([{ itemId: "a", desired: att }]);
  });
  it("deletes a surplus duplicate of a desired entry, keeping the first (C1)", () => {
    const tagged = [
      { itemId: "a", entryId: att.entryId, contentHash: att.hash },
      { itemId: "aDUP", entryId: att.entryId, contentHash: att.hash }, // a concurrent-sync duplicate
    ];
    const r = diffAll([att], tagged);
    expect(r.toDeleteIds).toEqual(["aDUP"]);
    expect(r.toCreate).toEqual([]);
    expect(r.toUpdate).toEqual([]);
  });
});

/**
 * Both glyph builders were written twice and knew only action counts and free
 * actions, so Salbarine Parry and The Ansu Refuses read as passive boons beside
 * "Maker's Wrath ◆◆". The frequency tag knew "day" and nothing else, which is
 * why the reaction lost its 1 / 10 min line as well. (item 24)
 */
describe("costGlyph", () => {
  it("draws one diamond per action", () => {
    expect(costGlyph({ actionType: "action", actions: 1 })).toBe("◆");
    expect(costGlyph({ actionType: "action", actions: 2 })).toBe("◆◆");
    expect(costGlyph({ actionType: "action", actions: 3 })).toBe("◆◆◆");
  });
  it("draws the free-action and reaction glyphs", () => {
    expect(costGlyph({ actionType: "free", actions: null })).toBe("◇");
    expect(costGlyph({ actionType: "reaction", actions: null })).toBe("↺");
  });
  it("draws nothing for a passive", () => {
    expect(costGlyph({ actionType: "passive" })).toBe("");
    expect(costGlyph({})).toBe("");
  });
  it("survives junk rather than throwing inside a repeat()", () => {
    expect(costGlyph()).toBe("");
    expect(costGlyph(null)).toBe("");
    expect(costGlyph({ actions: -1 })).toBe("");
    expect(costGlyph({ actions: 99 })).toBe("");
    expect(costGlyph({ actions: "two" })).toBe("");
    expect(costGlyph({ actions: 1.5 })).toBe("◆");
  });
});

describe("frequencyTag", () => {
  it("prefers the per-communion limit, which is the one the table plays by", () => {
    expect(frequencyTag({ perCommunion: true, frequency: { max: 1, per: "day" } })).toBe("1/communion");
  });
  it("names a daily frequency", () => {
    expect(frequencyTag({ frequency: { max: 1, per: "day" } })).toBe("1/day");
  });
  it("reads the cooldown minutes rather than parsing an ISO duration", () => {
    expect(frequencyTag({ frequency: { max: 1, per: "PT10M" }, cooldownMinutes: 10 })).toBe("1 / 10 min");
  });
  it("says nothing about an unlimited or per-round ability", () => {
    expect(frequencyTag({ frequency: { max: 1, per: "round" } })).toBe("");
    expect(frequencyTag({})).toBe("");
  });
  it("survives junk", () => {
    expect(frequencyTag()).toBe("");
    expect(frequencyTag(null)).toBe("");
    expect(frequencyTag({ cooldownMinutes: "ten" })).toBe("");
    expect(frequencyTag({ cooldownMinutes: 0 })).toBe("");
  });
});

describe("composeCommunion — ability glyphs and frequency tags", () => {
  const GLYPHS = {
    entries: [
      { id: "wrath", family: "wrath", rank: 1, level: 1, kind: "boon", form: "action", name: "Wrath",
        actionData: { actionType: "action", actions: 2 }, rules: [] },
      { id: "parry", family: "parry", rank: 1, level: 5, kind: "boon", form: "action", name: "Parry",
        actionData: { actionType: "reaction", actions: null }, rules: [] },
      { id: "refuses", family: "refuses", rank: 1, level: 7, kind: "boon", form: "action", name: "Refuses",
        actionData: { actionType: "reaction", actions: null, frequency: { max: 1, per: "PT10M" }, cooldownMinutes: 10 },
        rules: [] },
    ],
  };

  it("gives both reactions the reaction glyph instead of an empty one", () => {
    const lines = composeCommunion(state({ level: 7, communion: { mode: "active" } }), GLYPHS, { charLevel: 7 }).abilityLines;
    expect(lines.find((l) => l.name === "Parry").glyph).toBe("↺");
    expect(lines.find((l) => l.name === "Refuses").glyph).toBe("↺");
    expect(lines.find((l) => l.name === "Wrath").glyph).toBe("◆◆");
  });

  it("restores the reaction's frequency line from its cooldown minutes", () => {
    const lines = composeCommunion(state({ level: 7, communion: { mode: "active" } }), GLYPHS, { charLevel: 7 }).abilityLines;
    expect(lines.find((l) => l.name === "Refuses").tag).toBe("1 / 10 min");
    expect(lines.find((l) => l.name === "Wrath").tag).toBe("");
  });
});

/**
 * The ladder built ONE injection context at the bearer's own attunement and
 * reused it for every row, so an attunement 1 bearer's Discipline rows quoted
 * Trial numbers for boons that do not exist until 5. (item 25)
 */
describe("ladderCtxLevel", () => {
  it("previews a locked row at its own unlock level", () => {
    expect(ladderCtxLevel({ rowLevel: 5, level: 1 })).toBe(5);
    expect(ladderCtxLevel({ rowLevel: 9, level: 2 })).toBe(9);
  });
  it("keeps an unlocked row on the bearer's live numbers", () => {
    expect(ladderCtxLevel({ rowLevel: 1, level: 7 })).toBe(7);
    expect(ladderCtxLevel({ rowLevel: 7, level: 7 })).toBe(7);
  });
  it("floors an attunement 0 bearer at 1, the way buildCtx is called today", () => {
    expect(ladderCtxLevel({ rowLevel: 1, level: 0 })).toBe(1);
  });
  it("survives junk input", () => {
    expect(ladderCtxLevel()).toBe(1);
    expect(ladderCtxLevel({})).toBe(1);
    expect(ladderCtxLevel({ rowLevel: "five", level: null })).toBe(1);
    expect(ladderCtxLevel({ rowLevel: -4, level: -9 })).toBe(1);
  });

  it("makes the Salbarine rows read their real numbers at attunement 1", () => {
    const ctx = buildCtx(5, ladderCtxLevel({ rowLevel: 5, level: 1 }), {});
    expect(injectNumbers("resistance {{ansuResist}}", ctx)).toBe("resistance 3");
    expect(injectNumbers("resist {{ansuParry}} vs one hit", ctx)).toBe("resist 10 vs one hit");
  });

  it("still shows a level 7 bearer their own dice on the level 1 rows", () => {
    const ctx = buildCtx(9, ladderCtxLevel({ rowLevel: 1, level: 7 }), {});
    expect(injectNumbers("+{{ansuTierDice}}d6 strike", ctx)).toBe("+3d6 strike");
  });
});

describe("doorsDead", () => {
  it("closes the two doors only at the Taken terminal", () => {
    expect(doorsDead("taken")).toBe(true);
    for (const mode of ["none", "off", "active", "lingering", "seized", "permanent", undefined]) {
      expect(doorsDead(mode)).toBe(false);
    }
  });
});

/**
 * The Mastery gate chips carried no suppress control, so the one entry behind
 * the gate could never be taken off a subjugated master's sheet from the panel —
 * and hand-deleting it is exactly what the module undoes. Nothing in the
 * selection needed changing; it already honours a suppressed gated family. (item 22)
 */
describe("selectEntries — suppressing a gated family", () => {
  const master = (suppressed) => state({ level: 10, terminal: "subjugated", suppressed });

  it("keeps the capstone on an unsuppressed master", () => {
    expect(selectEntries(master([]), CONTENT).live.map((e) => e.id)).toContain("capstone");
  });

  it("drops it once its family is suppressed", () => {
    const live = selectEntries(master([{ id: "capstone", reason: "", at: 1 }]), CONTENT).live.map((e) => e.id);
    expect(live).not.toContain("capstone");
    expect(live).toContain("wrath");
  });

  it("drops it out of the composed actions too, so the sheet item goes away", () => {
    const ids = composeActions(master([{ id: "capstone", reason: "", at: 1 }]), CONTENT, { charLevel: 10 })
      .map((a) => a.entryId);
    expect(ids).not.toContain("capstone");
  });
});
