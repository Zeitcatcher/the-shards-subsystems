import { describe, it, expect } from "vitest";
import {
  applyDeed,
  degreeOf,
  lockoutActive,
  invokeBlock,
} from "../src/subsystems/ansu/logic/model.mjs";
import { callRerollTransition } from "../src/subsystems/ansu/logic/timing.mjs";
import { buildCtx, stampedRounds } from "../src/subsystems/ansu/logic/reconcile.mjs";

/** Step B of the 0.8 rework: the Call's pure rules. */

describe("degreeOf", () => {
  it("maps the four outcomes to 0..3 and anything else to null", () => {
    expect(["criticalFailure", "failure", "success", "criticalSuccess"].map(degreeOf)).toEqual([0, 1, 2, 3]);
    expect(degreeOf(null)).toBeNull();
    expect(degreeOf("nope")).toBeNull();
  });
});

describe("lockoutActive", () => {
  it("runs a timed lockout until its second, and a rest lockout until cleared", () => {
    expect(lockoutActive({ until: 60, untilRest: false }, 59)).toBe(true);
    expect(lockoutActive({ until: 60, untilRest: false }, 60)).toBe(false);
    expect(lockoutActive({ until: null, untilRest: true }, 1e9)).toBe(true);
    expect(lockoutActive(null, 0)).toBe(false);
    expect(lockoutActive({ until: "junk", untilRest: false }, 0)).toBe(false);
  });
});

describe("invokeBlock", () => {
  it("lets a clean bearer call", () => {
    expect(invokeBlock({})).toBeNull();
    expect(invokeBlock({ lockout: { until: 60, untilRest: false }, now: 61 })).toBeNull();
  });
  it("names each block, seized first", () => {
    expect(invokeBlock({ seized: true, fatigued: true })).toBe("seized");
    expect(invokeBlock({ pendingRelease: { id: "x" }, fatigued: true })).toBe("release");
    expect(invokeBlock({ pendingCall: { id: "x" } })).toBeNull();
    expect(invokeBlock({ lockout: { until: 60, untilRest: false }, now: 10, fatigued: true })).toBe("lockout");
    expect(invokeBlock({ fatigued: true })).toBe("fatigued");
  });
});

describe("callRerollTransition", () => {
  const T = (mode, prevOutcome, outcome) => callRerollTransition({ mode, prevOutcome, outcome });
  it("refuses to take back a granted Communion", () => {
    expect(T("active", "success", "criticalFailure").blocked).toBe(true);
    expect(T("active", "failure", "criticalFailure").blocked).toBe(true);
  });
  it("restamps one grant into another while Communion still runs", () => {
    expect(T("active", "failure", "criticalSuccess")).toEqual({
      blocked: false,
      restamp: true,
      liftLockout: false,
      invoke: false,
    });
  });
  it("reports a grant-to-grant correction as blocked once that Communion is over", () => {
    expect(T("none", "success", "criticalSuccess").blocked).toBe(true);
  });
  it("lifts the lockout of a corrected critical failure and starts Communion from dormant", () => {
    expect(T("none", "criticalFailure", "failure")).toEqual({
      blocked: false,
      restamp: false,
      liftLockout: true,
      invoke: true,
    });
    expect(T("active", "criticalFailure", "success")).toMatchObject({ liftLockout: true, invoke: false });
  });
  it("never touches a held body", () => {
    expect(T("seized", "criticalFailure", "success").blocked).toBe(true);
  });
  it("is inert on junk or an unchanged outcome", () => {
    const inert = { blocked: false, restamp: false, liftLockout: false, invoke: false };
    expect(callRerollTransition()).toEqual(inert);
    expect(T("active", "success", "success")).toEqual(inert);
  });
});

describe("the stamped Communion length", () => {
  it("reads communion.rounds when the Call stamped it", () => {
    expect(stampedRounds({ communion: { rounds: 2 } }, { durationRounds: 3 })).toBe(2);
    expect(stampedRounds({ communion: { rounds: 100 } }, { durationRounds: 10 })).toBe(100);
  });
  it("falls back to the tier length for an unstamped (pre-0.8) Communion", () => {
    expect(stampedRounds({ communion: { rounds: null } }, { durationRounds: 3 })).toBe(3);
    expect(stampedRounds({}, { durationRounds: 1 })).toBe(1);
  });
});

describe("buildCtx and loyalty", () => {
  it("moves {{ansuCallDC}} by the loyalty band", () => {
    expect(buildCtx(4, 4).callDc).toBe(28);
    expect(buildCtx(4, 4, {}, { loyalty: 0 }).callDc).toBe(30);
    expect(buildCtx(4, 4, {}, { loyalty: 2 }).callDc).toBe(29);
    expect(buildCtx(4, 4, {}, { loyalty: 5 }).callDc).toBe(28);
    expect(buildCtx(4, 4, {}, { loyalty: 9 }).callDc).toBe(27);
  });
});

describe("applyDeed at level 0", () => {
  it("never raises level 0 through loyalty: first attunement is the GM's", () => {
    const r = applyDeed({ level: 0, loyalty: 9, wrath: 0 }, { loyalty: 1 }, { charLevel: 10 });
    expect(r.leveled).toBe(false);
    expect(r.state.level).toBe(0);
    expect(r.state.loyalty).toBe(10);
  });
  it("still raises level 1 the same way", () => {
    const r = applyDeed({ level: 1, loyalty: 9, wrath: 0 }, { loyalty: 1 }, { charLevel: 10 });
    expect(r.leveled).toBe(true);
    expect(r.state.level).toBe(2);
  });
});
