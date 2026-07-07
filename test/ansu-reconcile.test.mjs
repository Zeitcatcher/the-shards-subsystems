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
  diffAll,
  ATTUNEMENT_ENTRY_ID,
  COMMUNION_ENTRY_ID,
} from "../src/subsystems/ansu/logic/reconcile.mjs";

/** Compact fixture mirroring the real content's shapes. */
const CONTENT = {
  entries: [
    { id: "invoke", family: "invoke", rank: 1, level: 1, kind: "boon", form: "action", name: "Invoke",
      actionData: { actionType: "action", actions: 1, frequency: { max: 1, per: "round" } }, rules: [] },
    { id: "vigor", family: "vigor", rank: 1, level: 1, kind: "boon", form: "effect", name: "Vigor",
      description: "<p>{{ansuTempHp}} temp HP.</p>",
      rules: [{ key: "TempHP", value: "{{ansuTempHp}}" }, { key: "FlatModifier", selector: "melee-strike-damage", type: "status", value: 1 }] },
    { id: "tongue", family: "tongue", rank: 1, level: 2, kind: "boon", form: "effect", always: true, name: "Tongue",
      rules: [{ key: "Note", selector: "all", title: "Tongue", text: "Knows Murkhor." }] },
    { id: "horns", family: "horns", rank: 1, level: 4, kind: "boon", form: "strike", name: "Horns",
      rules: [], strikeData: { die: "d8", damageType: "piercing" } },
    { id: "skin", family: "skin", rank: 1, level: 5, kind: "boon", form: "effect", name: "Skin",
      rules: [{ key: "Resistance", type: "physical", value: "{{ansuResist}}" }] },
    { id: "vigor-2", family: "vigor", rank: 2, level: 7, kind: "boon", form: "effect", name: "Vigor (Union)",
      rules: [{ key: "TempHP", value: "{{ansuTempHp}}" }, { key: "FlatModifier", selector: "melee-strike-damage", type: "status", value: 2 }] },
    { id: "capstone", family: "capstone", rank: 1, level: 10, kind: "boon", form: "action", gate: "subjugated",
      name: "Capstone", actionData: { actionType: "action", actions: 1 }, rules: [] },
  ],
};

const state = (over = {}) => ({
  enabled: true, level: 0, climb: 0, terminal: null, suppressed: [],
  communion: { mode: "none", rounds: null }, pendingRelease: null, seizure: null, log: [], ...over,
});

describe("selectEntries", () => {
  it("unlocks by level, highest rank per family wins", () => {
    const low = selectEntries(state({ level: 2 }), CONTENT);
    expect(low.live.map((e) => e.id)).toEqual(["invoke", "vigor", "tongue"]);
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

describe("numbers", () => {
  it("buildCtx bakes formula-B DC, temp HP, resistance and duration", () => {
    const ctx = buildCtx(4, 4);
    expect(ctx.releaseDc).toBe(22);
    expect(ctx.tempHp).toBe(8);
    expect(ctx.resist).toBe(2);
    expect(ctx.durationRounds).toBe(3);
  });
  it("injectNumbers replaces every token", () => {
    const ctx = buildCtx(4, 5);
    expect(injectNumbers("DC {{ansuReleaseDC}}, {{ansuTempHp}} THP, res {{ansuResist}}, att {{ansuLevel}}, {{ansuDuration}}", ctx))
      .toBe("DC 24, 10 THP, res 2, att 5, 3 rounds");
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
  it("carries ONLY the always-on inheritance rules plus roll options", () => {
    const c = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5 });
    const keys = c.rules.map((r) => r.key);
    expect(keys.filter((k) => k === "RollOption")).toHaveLength(3);
    expect(keys).toContain("Note"); // tongue (always)
    expect(keys).not.toContain("TempHP"); // vigor lives on Communion
    expect(c.inheritanceLines.map((l) => l.name)).toEqual(["Tongue"]);
  });
  it("terminal badge runs to 10", () => {
    const c = composeAttunement(state({ level: 10, terminal: "subjugated" }), CONTENT, { charLevel: 8 });
    expect(c.badge).toEqual({ value: 10, max: 10 });
    expect(c.tier).toBe("subjugated");
  });
});

describe("composeCommunion", () => {
  it("is null while dormant and while a master toggled off", () => {
    expect(composeCommunion(state({ level: 3 }), CONTENT, { charLevel: 4 })).toBeNull();
    expect(composeCommunion(state({ terminal: "subjugated", level: 10, communion: { mode: "none" } }), CONTENT, { charLevel: 8 })).toBeNull();
  });
  it("active carries the non-always boon rules, the strike RE, and injected numbers", () => {
    const c = composeCommunion(state({ level: 5, communion: { mode: "active", rounds: 3 } }), CONTENT, { charLevel: 5 });
    expect(c.entryId).toBe(COMMUNION_ENTRY_ID);
    expect(c.mode).toBe("active");
    expect(c.durationRounds).toBe(3);
    const keys = c.rules.map((r) => r.key);
    expect(keys).toContain("TempHP");
    expect(keys).toContain("Strike"); // horns
    expect(keys).toContain("Resistance");
    expect(keys).not.toContain("Note"); // inheritance stays on the marker
    const resist = c.rules.find((r) => r.key === "Resistance");
    expect(resist.value).toBe(2); // {{ansuResist}} baked to a NUMBER, not a string
    const temp = c.rules.find((r) => r.key === "TempHP");
    expect(temp.value).toBe(10);
  });
  it("seizure composes at full strength regardless of level", () => {
    const c = composeCommunion(state({ level: 1, communion: { mode: "seized" } }), CONTENT, { charLevel: 4 });
    expect(c.level).toBe(10);
    expect(c.permanent).toBe(false);
    const damage = c.rules.filter((r) => r.key === "FlatModifier" && r.selector === "melee-strike-damage");
    expect(damage).toHaveLength(1);
    expect(damage[0].value).toBe(2); // vigor rank 2 shadowed rank 1
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

describe("composeActions", () => {
  it("action items exist once unlocked, with numbers injected", () => {
    const acts = composeActions(state({ level: 1 }), CONTENT, { charLevel: 4 });
    expect(acts.map((a) => a.entryId)).toEqual(["invoke"]);
  });
  it("seizure unlocks every active including the gate", () => {
    const acts = composeActions(state({ level: 1, communion: { mode: "seized" } }), CONTENT, { charLevel: 4 });
    expect(acts.map((a) => a.entryId)).toEqual(expect.arrayContaining(["invoke", "capstone"]));
  });
});

describe("diffAll", () => {
  const att = composeAttunement(state({ level: 5 }), CONTENT, { charLevel: 5 });
  const comm = composeCommunion(state({ level: 5, communion: { mode: "active" } }), CONTENT, { charLevel: 5 });
  const acts = composeActions(state({ level: 5 }), CONTENT, { charLevel: 5 });
  const desired = [att, comm, ...acts];

  it("creates everything from scratch", () => {
    const { toCreate, toUpdate, toDeleteIds } = diffAll(desired, []);
    expect(toCreate).toHaveLength(desired.length);
    expect(toUpdate).toHaveLength(0);
    expect(toDeleteIds).toHaveLength(0);
  });
  it("is idempotent when hashes match and deletes strays", () => {
    const tagged = desired.map((d, i) => ({ itemId: `i${i}`, entryId: d.entryId, contentHash: d.hash }));
    const clean = diffAll(desired, tagged);
    expect(clean.toCreate).toHaveLength(0);
    expect(clean.toUpdate).toHaveLength(0);
    const withStray = diffAll(desired, [...tagged, { itemId: "zz", entryId: "gone", contentHash: "x" }]);
    expect(withStray.toDeleteIds).toEqual(["zz"]);
  });
  it("updates in place on a hash change", () => {
    const tagged = [{ itemId: "a", entryId: att.entryId, contentHash: "stale" }];
    const { toUpdate } = diffAll([att], tagged);
    expect(toUpdate).toEqual([{ itemId: "a", desired: att }]);
  });
});
