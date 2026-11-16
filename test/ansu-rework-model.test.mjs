import { describe, it, expect } from "vitest";
import {
  durationRoundsFor,
  loyaltyBand,
  callAdjust,
  callDCFor,
  releaseDCFor,
  wrathBand,
  LEVEL_DC,
  conflictDC,
  hpLoss,
  lockoutAfterRelease,
  CALL_CF_LOCKOUT,
  makeLockout,
  takeoverCap,
  gateMax,
  recallRange,
  recalls,
  throwIncrement,
  applyDeed,
  nightRest,
  clampLoyalty,
  clampWrath,
} from "../src/subsystems/ansu/logic/model.mjs";

describe("durationRoundsFor", () => {
  it("follows the tier tables by degree CF/F/S/CS", () => {
    for (const l of [1, 2, 3]) expect([0, 1, 2, 3].map((d) => durationRoundsFor(l, d))).toEqual([0, 1, 3, 10]);
    for (const l of [4, 5, 6]) expect([0, 1, 2, 3].map((d) => durationRoundsFor(l, d))).toEqual([0, 2, 5, 10]);
    for (const l of [7, 8, 9]) expect([0, 1, 2, 3].map((d) => durationRoundsFor(l, d))).toEqual([0, 3, 10, 100]);
  });
  it("level 10 is permanent (null), level 0 has nothing", () => {
    expect(durationRoundsFor(10, 2)).toBeNull();
    expect(durationRoundsFor(0, 3)).toBe(0);
  });
});

describe("loyalty and wrath bands", () => {
  it("loyaltyBand edges", () => {
    expect([0, 1, 3, 4, 6, 7, 10].map(loyaltyBand)).toEqual(["hostile", "cold", "cold", "wary", "wary", "trust", "trust"]);
  });
  it("callAdjust by band", () => {
    expect([0, 2, 5, 9].map(callAdjust)).toEqual([2, 1, 0, -1]);
  });
  it("wrathBand edges", () => {
    expect([0, 2, 3, 5, 6].map(wrathBand)).toEqual(["calm", "calm", "angry", "angry", "breaking"]);
  });
  it("clamps", () => {
    expect(clampLoyalty(12)).toBe(10);
    expect(clampLoyalty(-3)).toBe(0);
    expect(clampLoyalty(undefined)).toBe(5);
    expect(clampWrath(9)).toBe(6);
    expect(clampWrath("x")).toBe(0);
  });
});

describe("DCs", () => {
  it("callDCFor = 20 + 2 x level + adjust", () => {
    expect(callDCFor(3, 5)).toBe(26);
    expect(callDCFor(3, 0)).toBe(28);
    expect(callDCFor(3, 2)).toBe(27);
    expect(callDCFor(8, 8)).toBe(35);
    expect(callDCFor(3, 5, { base: 10, step: 1 })).toBe(13);
  });
  it("releaseDCFor = 20 + 2 x min(level,5) + penalty", () => {
    expect(releaseDCFor(3, 0)).toBe(26);
    expect(releaseDCFor(8, 0)).toBe(30);
    expect(releaseDCFor(8, 2)).toBe(32);
    expect(releaseDCFor(2)).toBe(24);
  });
  it("LEVEL_DC table", () => {
    expect(LEVEL_DC).toHaveLength(21);
    expect(LEVEL_DC[0]).toBe(14);
    expect(LEVEL_DC[8]).toBe(24);
    expect(LEVEL_DC[20]).toBe(40);
  });
  it("conflictDC adds severity and wrath", () => {
    expect(conflictDC(8, "minor", 0)).toBe(24);
    expect(conflictDC(8, "serious", 2)).toBe(26);
    expect(conflictDC(8, "betrayal", 3)).toBe(31);
    expect(conflictDC(8, "nonsense", 6)).toBe(26);
    expect(conflictDC(25, "minor", 0)).toBe(40);
  });
});

describe("hpLoss and lockouts", () => {
  it("hpLoss F 2x, CF 4x, success none", () => {
    expect(hpLoss(4, 1)).toBe(8);
    expect(hpLoss(4, 0)).toBe(16);
    expect(hpLoss(4, 2)).toBe(0);
    expect(hpLoss(4, 3)).toBe(0);
  });
  it("lockoutAfterRelease by tier", () => {
    expect(lockoutAfterRelease(2)).toEqual({ seconds: null, untilRest: true });
    expect(lockoutAfterRelease(5)).toEqual({ seconds: 3600, untilRest: false });
    expect(lockoutAfterRelease(8)).toEqual({ seconds: 600, untilRest: false });
    expect(lockoutAfterRelease(10)).toBeNull();
    expect(lockoutAfterRelease(0)).toBeNull();
  });
  it("makeLockout stamps world time", () => {
    expect(makeLockout(CALL_CF_LOCKOUT, 1000)).toEqual({ until: 1060, untilRest: false });
    expect(makeLockout(lockoutAfterRelease(1), 1000)).toEqual({ until: null, untilRest: true });
    expect(makeLockout(null, 1000)).toBeNull();
  });
});

describe("caps and the blade", () => {
  it("takeoverCap and gateMax", () => {
    expect(takeoverCap(3)).toBe(6);
    expect(takeoverCap(9)).toBe(10);
    expect(gateMax(1)).toBe(1);
    expect(gateMax(8)).toBe(4);
    expect(gateMax(17)).toBe(8);
  });
  it("recallRange", () => {
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map(recallRange)).toEqual([0, 40, 50, 60, 80, 100, 150, 200, 300]);
  });
  it("recalls with the trust bonus", () => {
    expect([3, 4, 5, 6, 7, 8, 9].map((l) => recalls(l, 5))).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(recalls(5, 7)).toBe(3);
    expect(recalls(2, 10)).toBe(0);
    expect(recalls(10, 0)).toBe(Infinity);
  });
  it("throwIncrement", () => {
    expect([0, 2, 5, 8, 10].map(throwIncrement)).toEqual([0, 30, 40, 60, 80]);
  });
});

const D = {
  victory: { loyalty: 1, wrath: -1 },
  task: { loyalty: 2, wrathSet: 0 },
  broke: { loyalty: -2, wrath: 2 },
  night: { loyalty: 0, wrath: -1, wrathSkipAtLoyalty0: true },
  berserkEnd: { loyalty: -1, wrathSet: 2 },
};

describe("applyDeed", () => {
  it("moves and clamps loyalty and wrath", () => {
    const r = applyDeed({ level: 3, loyalty: 1, wrath: 5 }, D.broke, { charLevel: 8 });
    expect(r.state.loyalty).toBe(0);
    expect(r.state.wrath).toBe(6);
    expect(r.loyalty).toEqual([1, 0]);
    expect(r.wrath).toEqual([5, 6]);
    expect(r.leveled).toBe(false);
  });
  it("wrathSet overrides the delta", () => {
    expect(applyDeed({ level: 3, loyalty: 5, wrath: 4 }, D.task, { charLevel: 8 }).state.wrath).toBe(0);
    expect(applyDeed({ level: 3, loyalty: 5, wrath: 6 }, D.berserkEnd, { charLevel: 8 }).state.wrath).toBe(2);
  });
  it("night skips the wrath move at loyalty 0", () => {
    expect(applyDeed({ level: 3, loyalty: 0, wrath: 4 }, D.night, { charLevel: 8 }).state.wrath).toBe(4);
    expect(applyDeed({ level: 3, loyalty: 1, wrath: 4 }, D.night, { charLevel: 8 }).state.wrath).toBe(3);
  });
  it("levels up at loyalty 10 with calm wrath under the gate", () => {
    const st = { level: 3, loyalty: 9, wrath: 3, other: "kept" };
    const r = applyDeed(st, D.victory, { charLevel: 8 });
    expect(r.leveled).toBe(true);
    expect(r.state).toEqual({ level: 4, loyalty: 5, wrath: 0, other: "kept" });
    expect(r.level).toEqual([3, 4]);
    expect(st.level).toBe(3);
  });
  it("no level-up while angry", () => {
    const r = applyDeed({ level: 3, loyalty: 9, wrath: 5 }, D.victory, { charLevel: 8 });
    expect(r.leveled).toBe(false);
    expect(r.state.loyalty).toBe(10);
    expect(r.state.wrath).toBe(4);
  });
  it("no level-up at the character-level gate", () => {
    const r = applyDeed({ level: 4, loyalty: 9, wrath: 0 }, D.victory, { charLevel: 8 });
    expect(r.leveled).toBe(false);
    expect(r.state.level).toBe(4);
  });
  it("nothing automatic at level 9 or at a terminal", () => {
    expect(applyDeed({ level: 9, loyalty: 9, wrath: 0 }, D.task, { charLevel: 20 }).leveled).toBe(false);
    expect(applyDeed({ level: 5, loyalty: 9, wrath: 0, terminal: "taken" }, D.task, { charLevel: 20 }).leveled).toBe(false);
  });
});

describe("nightRest", () => {
  it("lowers wrath, clears a rest lockout, resets consent", () => {
    const r = nightRest({ loyalty: 5, wrath: 3, lockout: { until: null, untilRest: true }, consentUsed: true });
    expect(r).toEqual({ loyalty: 5, wrath: 2, lockout: null, consentUsed: false });
  });
  it("keeps wrath at loyalty 0 and a timed lockout", () => {
    const lo = { until: 5000, untilRest: false };
    const r = nightRest({ loyalty: 0, wrath: 3, lockout: lo, consentUsed: true });
    expect(r.wrath).toBe(3);
    expect(r.lockout).toEqual(lo);
    expect(r.consentUsed).toBe(false);
  });
  it("wrath never goes below 0", () => {
    expect(nightRest({ loyalty: 5, wrath: 0, lockout: null }).wrath).toBe(0);
  });
});
