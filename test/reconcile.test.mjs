import { describe, it, expect } from "vitest";
import {
  selectEntries,
  composeEffect,
  composeActions,
  diffAll,
  injectNumbers,
  buildCtx,
  EFFECT_ENTRY_ID,
} from "../src/subsystems/izir/logic/reconcile.mjs";
import { izirAttack, izirDC } from "../src/subsystems/izir/logic/model.mjs";
import { emptyIzirState } from "../src/subsystems/izir/state.mjs";

const CONTENT = {
  entries: [
    {
      id: "voidsight", family: "voidsight", rank: 1, level: 1, kind: "boon", form: "effect",
      name: "Voidsight", description: "<p>See.</p>", rules: [{ key: "Sense", selector: "darkvision" }],
    },
    {
      id: "void-lash", family: "void-lash", rank: 1, level: 1, kind: "boon", form: "strike",
      name: "Void Lash", description: "<p>Lash at {{izirAttack}}.</p>", rules: [],
      strikeData: { range: 30, die: "d4", damageType: "void" },
    },
    {
      id: "mark", family: "mark", rank: 1, level: 2, kind: "bane", form: "effect",
      name: "The Mark", description: "<p>Marked.</p>",
      rules: [{ key: "FlatModifier", selector: "diplomacy", type: "circumstance", value: -1, label: "SHARDS.Izir.MaskedLabel" }],
    },
    {
      id: "wave1", family: "wave", rank: 1, level: 3, kind: "boon", form: "action",
      name: "Wave I", description: "<p>DC {{izirDC}}.</p>", rules: [],
      actionData: { actionType: "action", actions: 2, recharge: "1d6" },
    },
    {
      id: "wave2", family: "wave", rank: 2, level: 5, kind: "boon", form: "action",
      name: "Wave II", description: "<p>Bigger, DC {{izirDC}}.</p>", rules: [],
      actionData: { actionType: "action", actions: 2, recharge: "1d6" },
    },
    {
      id: "sovereign", family: "sovereign", rank: 1, level: 10, kind: "boon", form: "effect",
      name: "Sovereign Will", description: "<p>Master.</p>", gate: "subjugated",
      rules: [{ key: "Immunity", type: "void" }],
    },
  ],
};

const at = (over) => ({ ...emptyIzirState(), ...over });

describe("selectEntries", () => {
  it("unlocks by level and keeps the best rank per family", () => {
    const { live, replacedIds } = selectEntries(at({ level: 5 }), CONTENT);
    const ids = live.map((e) => e.id);
    expect(ids).toContain("wave2");
    expect(ids).not.toContain("wave1");
    expect(replacedIds).toContain("wave1");
  });
  it("drops suppressed families (boon or bane)", () => {
    const { live } = selectEntries(at({ level: 5, suppressed: [{ id: "mark" }, { id: "voidsight" }] }), CONTENT);
    const ids = live.map((e) => e.id);
    expect(ids).not.toContain("mark");
    expect(ids).not.toContain("voidsight");
  });
  it("gated entries need subjugation", () => {
    expect(selectEntries(at({ level: 10 }), CONTENT).live.map((e) => e.id)).not.toContain("sovereign");
    expect(selectEntries(at({ level: 10, terminal: "subjugated" }), CONTENT).live.map((e) => e.id)).toContain("sovereign");
  });
});

describe("injectNumbers + buildCtx", () => {
  it("replaces all runtime tokens", () => {
    const out = injectNumbers("DC {{izirDC}} atk {{izirAttack}} lv {{izirLevel}}", { dc: 21, attack: 11, level: 5 });
    expect(out).toBe("DC 21 atk 11 lv 5");
  });
  it("computes the deepening holy weakness (2 → 4 at 6 → 6 at 8)", () => {
    expect(buildCtx(5, 3).holyWeak).toBe(2);
    expect(buildCtx(5, 5).holyWeak).toBe(2);
    expect(buildCtx(5, 6).holyWeak).toBe(4);
    expect(buildCtx(5, 8).holyWeak).toBe(6);
    expect(injectNumbers("holy {{izirHolyWeak}}", buildCtx(5, 6))).toBe("holy 4");
  });
  it("anchors dc/attack to the caster baseline", () => {
    expect(buildCtx(5, 5).attack).toBe(11);
    expect(buildCtx(5, 5).dc).toBe(21);
  });
});

describe("composeEffect", () => {
  it("is null when unmarked or dormant", () => {
    expect(composeEffect(at({ level: 0 }), CONTENT, { charLevel: 5 })).toBeNull();
    expect(composeEffect(at({ level: 5, enabled: false }), CONTENT, { charLevel: 5 })).toBeNull();
  });

  it("carries marker roll options, badge = level, and composed rules", () => {
    const c = composeEffect(at({ level: 2 }), CONTENT, { charLevel: 5 });
    expect(c.badge.value).toBe(2);
    const opts = c.rules.filter((r) => r.key === "RollOption").map((r) => r.option);
    expect(opts).toContain("self:shards:izir");
    expect(opts).toContain("self:shards:izir:level:2");
    expect(c.rules.some((r) => r.key === "Sense")).toBe(true);
  });

  it("masks hidden bane labels and unmasks revealed ones", () => {
    const hidden = composeEffect(at({ level: 2 }), CONTENT, { charLevel: 5 });
    const fm1 = hidden.rules.find((r) => r.key === "FlatModifier");
    expect(fm1.label).toBe("SHARDS.Izir.MaskedLabel");
    expect(hidden.priceLines).toHaveLength(0);
    expect(hidden.hiddenPrices).toBe(1);

    const shown = composeEffect(at({ level: 2, revealed: ["mark"] }), CONTENT, { charLevel: 5 });
    const fm2 = shown.rules.find((r) => r.key === "FlatModifier");
    expect(fm2.label).toBe("The Mark");
    expect(shown.priceLines.map((p) => p.name)).toContain("The Mark");
  });

  it("transparency reveals every price", () => {
    const c = composeEffect(at({ level: 2 }), CONTENT, { charLevel: 5, transparency: true });
    expect(c.hiddenPrices).toBe(0);
    expect(c.priceLines).toHaveLength(1);
  });

  it("builds the strike with the fixed Izir attack modifier and level-scaled dice", () => {
    const c = composeEffect(at({ level: 5 }), CONTENT, { charLevel: 5 });
    const strike = c.rules.find((r) => r.key === "Strike");
    expect(strike.attackModifier).toBe(izirAttack(5, 5));
    expect(strike.damage.base.dice).toBe(Math.ceil(5 / 2));
    expect(strike.range).toBe(30);
    // official Strike shape: no category field (pf2e drops invalid REs silently)
    expect("category" in strike).toBe(false);
  });

  it("lists unlocked actives in abilityLines so the card shows upgrades", () => {
    const c3 = composeEffect(at({ level: 3 }), CONTENT, { charLevel: 5 });
    expect(c3.abilityLines.map((a) => a.name)).toEqual(["Wave I"]);
    const c5 = composeEffect(at({ level: 5 }), CONTENT, { charLevel: 5 });
    expect(c5.abilityLines.map((a) => a.name)).toEqual(["Wave II"]);
    expect(c5.abilityLines[0].glyph).toBe("◆◆");
    expect(c5.abilityLines[0].tag).toBe("R 1d6");
    // actions are not duplicated into the Gifts list
    expect(c5.boonLines.map((b) => b.name)).not.toContain("Wave II");
  });

  it("nineveh strips to a terminal marker", () => {
    const c = composeEffect(at({ level: 10, terminal: "nineveh" }), CONTENT, { charLevel: 5 });
    expect(c.boonLines).toHaveLength(0);
    expect(c.rules.every((r) => r.key === "RollOption")).toBe(true);
    expect(c.tier).toBe("nineveh");
  });

  it("subjugation includes the gated capstone", () => {
    const c = composeEffect(at({ level: 10, terminal: "subjugated" }), CONTENT, { charLevel: 5 });
    expect(c.rules.some((r) => r.key === "Immunity")).toBe(true);
    expect(c.tier).toBe("subjugated");
  });

  it("hash reacts to reveal/suppress/level changes", () => {
    const a = composeEffect(at({ level: 2 }), CONTENT, { charLevel: 5 });
    const b = composeEffect(at({ level: 2, revealed: ["mark"] }), CONTENT, { charLevel: 5 });
    const c = composeEffect(at({ level: 3 }), CONTENT, { charLevel: 5 });
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe("composeActions", () => {
  it("returns only unlocked action-form actives with injected numbers", () => {
    const acts = composeActions(at({ level: 5 }), CONTENT, { charLevel: 5 });
    expect(acts.map((a) => a.entryId)).toEqual(["wave2"]);
    expect(acts[0].description).toContain(`DC ${izirDC(5, 5)}`);
  });
  it("is empty for nineveh and level 0", () => {
    expect(composeActions(at({ level: 10, terminal: "nineveh" }), CONTENT, { charLevel: 5 })).toEqual([]);
    expect(composeActions(at({ level: 0 }), CONTENT, { charLevel: 5 })).toEqual([]);
  });
});

describe("diffAll", () => {
  const effect = { entryId: EFFECT_ENTRY_ID, hash: "e1" };
  const wave = { entryId: "wave2", hash: "w1" };

  it("creates everything against an empty actor", () => {
    const { toCreate, toUpdate, toDeleteIds } = diffAll(effect, [wave], []);
    expect(toCreate.map((d) => d.entryId)).toEqual([EFFECT_ENTRY_ID, "wave2"]);
    expect(toUpdate).toEqual([]);
    expect(toDeleteIds).toEqual([]);
  });

  it("is a no-op when hashes match", () => {
    const tagged = [
      { itemId: "i1", entryId: EFFECT_ENTRY_ID, contentHash: "e1" },
      { itemId: "i2", entryId: "wave2", contentHash: "w1" },
    ];
    const r = diffAll(effect, [wave], tagged);
    expect(r.toCreate).toEqual([]);
    expect(r.toUpdate).toEqual([]);
    expect(r.toDeleteIds).toEqual([]);
  });

  it("updates in place on hash drift and deletes orphans", () => {
    const tagged = [
      { itemId: "i1", entryId: EFFECT_ENTRY_ID, contentHash: "STALE" },
      { itemId: "i9", entryId: "wave1", contentHash: "z" },
    ];
    const r = diffAll(effect, [wave], tagged);
    expect(r.toUpdate.map((u) => u.itemId)).toEqual(["i1"]);
    expect(r.toCreate.map((d) => d.entryId)).toEqual(["wave2"]);
    expect(r.toDeleteIds).toEqual(["i9"]);
  });

  it("deletes everything when nothing is desired", () => {
    const tagged = [
      { itemId: "i1", entryId: EFFECT_ENTRY_ID, contentHash: "e1" },
      { itemId: "i2", entryId: "wave2", contentHash: "w1" },
    ];
    const r = diffAll(null, [], tagged);
    expect(r.toDeleteIds.sort()).toEqual(["i1", "i2"]);
  });
});
