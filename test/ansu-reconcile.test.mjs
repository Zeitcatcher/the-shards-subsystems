import { describe, it, expect } from "vitest";
import {
  selectEntries,
  buildCtx,
  injectNumbers,
  durationLabel,
  communionMode,
  composeAttunement,
  composeCommunion,
  composeActions,
  composeFeats,
  diffAll,
  ATTUNEMENT_ENTRY_ID,
  COMMUNION_ENTRY_ID,
} from "../src/subsystems/ansu/logic/reconcile.mjs";

/** Compact fixture mirroring the real content's shapes (rev 3). */
const CONTENT = {
  entries: [
    { id: "invoke", family: "invoke", rank: 1, level: 1, kind: "boon", form: "action", name: "Invoke",
      actionData: { actionType: "action", actions: 1, frequency: { max: 1, per: "round" }, alwaysAvailable: true }, rules: [] },
    { id: "wrath", family: "wrath", rank: 1, level: 1, kind: "boon", form: "action", name: "Wrath",
      description: "<p>+{{ansuTierDice}}d6.</p>", actionData: { actionType: "action", actions: 2 }, rules: [] },
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
  it("buildCtx bakes DC 20+2×min(N,5), temp HP 3×, resistance /2, parry, tier dice", () => {
    const ctx = buildCtx(4, 4);
    expect(ctx.releaseDc).toBe(28);
    expect(ctx.tempHp).toBe(12);
    expect(ctx.resist).toBe(2);
    expect(ctx.parry).toBe(8);
    expect(ctx.tierDice).toBe(2);
    expect(ctx.durationRounds).toBe(3);
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

describe("composeActions — module-owned cooldowns", () => {
  const running = (cooldowns, now) =>
    composeActions(state({ level: 7, communion: { mode: "active" }, cooldowns }), CONTENT, { charLevel: 8, now });

  it("zeroes the frequency while the cooldown runs and restores it after", () => {
    const cooling = running([{ id: "refuses", until: 1000 }], 400);
    expect(cooling.find((a) => a.entryId === "refuses").actionData.frequencyValue).toBe(0);
    const recovered = running([{ id: "refuses", until: 1000 }], 1000);
    expect(recovered.find((a) => a.entryId === "refuses").actionData.frequencyValue).toBe(1);
  });
  it("leaves ordinary frequencies unmanaged (pf2e owns their uses)", () => {
    const acts = running([], 0);
    expect(acts.find((a) => a.entryId === "invoke").actionData.frequencyValue).toBeUndefined();
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
});
