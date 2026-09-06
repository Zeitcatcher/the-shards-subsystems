import { describe, it, expect } from "vitest";
import {
  sweepHandlesExpiry,
  classifyCommunionDelete,
  acceptReleaseRoll,
  turnEndReleaseDue,
  seizureReturnDue,
  RELEASE_OPTION,
  RELEASE_ID_PREFIX,
} from "../src/subsystems/ansu/logic/timing.mjs";

describe("sweepHandlesExpiry", () => {
  it("stands down on the first sweep when pf2e auto-removes expired effects", () => {
    expect(sweepHandlesExpiry(true, false)).toBe(false);
  });
  it("steps in on the next sweep when the effect is still sitting there expired", () => {
    expect(sweepHandlesExpiry(true, true)).toBe(true);
  });
  it("owns the expiry outright when auto-removal is off", () => {
    expect(sweepHandlesExpiry(false, false)).toBe(true);
    expect(sweepHandlesExpiry(false, true)).toBe(true);
  });
  it("owns the expiry when the setting is unreadable (fail-safe: never lose one)", () => {
    expect(sweepHandlesExpiry(undefined, false)).toBe(true);
    expect(sweepHandlesExpiry(null, false)).toBe(true);
    expect(sweepHandlesExpiry("true", false)).toBe(true);
    expect(sweepHandlesExpiry(1, false)).toBe(true);
  });
  it("treats a non-boolean grace flag as a first sweep", () => {
    expect(sweepHandlesExpiry(true, undefined)).toBe(false);
    expect(sweepHandlesExpiry(true, "yes")).toBe(false);
  });
});

describe("classifyCommunionDelete", () => {
  it("expired + active is the countdown running out", () => {
    expect(classifyCommunionDelete({ terminal: null, mode: "active", wasExpired: true })).toBe("expiry");
  });
  it("expired + lingering is pf2e clearing a spent item the sweep already resolved", () => {
    expect(classifyCommunionDelete({ terminal: null, mode: "lingering", wasExpired: true })).toBe("resync");
  });
  it("expired with nothing running is a plain self-heal", () => {
    expect(classifyCommunionDelete({ terminal: null, mode: "none", wasExpired: true })).toBe("heal");
    expect(classifyCommunionDelete({ terminal: null, mode: "seized", wasExpired: true })).toBe("heal");
  });
  it("a live delete of a running Communion is deliberate", () => {
    expect(classifyCommunionDelete({ terminal: null, mode: "active", wasExpired: false })).toBe("end");
    expect(classifyCommunionDelete({ terminal: null, mode: "lingering", wasExpired: false })).toBe("end");
  });
  it("a live delete with nothing running is a plain self-heal", () => {
    expect(classifyCommunionDelete({ terminal: null, mode: "none", wasExpired: false })).toBe("heal");
    expect(classifyCommunionDelete({ terminal: null, mode: "seized", wasExpired: false })).toBe("heal");
  });
  it("a terminal never expires or ends: always self-heal", () => {
    for (const terminal of ["subjugated", "taken"]) {
      for (const mode of ["active", "lingering", "none", "seized"]) {
        expect(classifyCommunionDelete({ terminal, mode, wasExpired: true })).toBe("heal");
        expect(classifyCommunionDelete({ terminal, mode, wasExpired: false })).toBe("heal");
      }
    }
  });
  it("survives junk input", () => {
    expect(classifyCommunionDelete()).toBe("heal");
    expect(classifyCommunionDelete({})).toBe("heal");
    // only a hard true counts as expired — an undefined flag is not an expiry
    expect(classifyCommunionDelete({ terminal: null, mode: "active", wasExpired: undefined })).toBe("end");
  });
});

describe("acceptReleaseRoll", () => {
  const id = "abc123";
  const withId = (v) => [RELEASE_OPTION, `${RELEASE_ID_PREFIX}${v}`];

  it("accepts the matching card", () => {
    expect(acceptReleaseRoll({ options: withId(id), pendingId: id })).toEqual({
      accept: true,
      idMatch: true,
      rolledId: id,
    });
  });
  it("accepts a mismatched card id and reports the mismatch", () => {
    expect(acceptReleaseRoll({ options: withId("stale999"), pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: "stale999",
    });
  });
  it("accepts a card with no id at all and reports the mismatch", () => {
    expect(acceptReleaseRoll({ options: [RELEASE_OPTION], pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: null,
    });
  });
  it("never captures a save without our roll option, even at the same DC", () => {
    const foreign = ["check:statistic:fortitude", "item:trait:poison", "dc:22"];
    expect(acceptReleaseRoll({ options: foreign, pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: null,
    });
  });
  it("never captures a stray id option without our roll option", () => {
    expect(acceptReleaseRoll({ options: [`${RELEASE_ID_PREFIX}${id}`], pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: id,
    });
  });
  it("has nothing to capture with no open Release", () => {
    expect(acceptReleaseRoll({ options: withId(id), pendingId: null })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: id,
    });
    expect(acceptReleaseRoll({ options: withId(id), pendingId: "" })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: id,
    });
  });
  it("survives missing or junk options", () => {
    expect(acceptReleaseRoll()).toEqual({ accept: false, idMatch: false, rolledId: null });
    expect(acceptReleaseRoll({ options: null, pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: null,
    });
    expect(acceptReleaseRoll({ options: [null, 7, RELEASE_OPTION], pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: null,
    });
  });
});

describe("turnEndReleaseDue", () => {
  it("owes a fresh card at the end of a lingering bearer's turn", () => {
    expect(turnEndReleaseDue({ mode: "lingering", terminal: null })).toBe(true);
  });
  it("owes nothing while the countdown still runs, the body is held, or nothing is on", () => {
    expect(turnEndReleaseDue({ mode: "active", terminal: null })).toBe(false);
    expect(turnEndReleaseDue({ mode: "seized", terminal: null })).toBe(false);
    expect(turnEndReleaseDue({ mode: "none", terminal: null })).toBe(false);
  });
  it("owes nothing at a terminal, lingering included", () => {
    expect(turnEndReleaseDue({ mode: "lingering", terminal: "subjugated" })).toBe(false);
    expect(turnEndReleaseDue({ mode: "lingering", terminal: "taken" })).toBe(false);
  });
  it("survives junk input", () => {
    expect(turnEndReleaseDue()).toBe(false);
    expect(turnEndReleaseDue({})).toBe(false);
  });
});

describe("seizureReturnDue", () => {
  const auto = { seized: true, auto: true };

  it("holds through the round the seizure began in", () => {
    expect(seizureReturnDue({ ...auto, startRound: 3, round: 3 })).toBe(false);
    expect(seizureReturnDue({ ...auto, startRound: 3, round: 2 })).toBe(false);
  });
  it("returns the body at the end of the bearer's next turn (a later round)", () => {
    expect(seizureReturnDue({ ...auto, startRound: 3, round: 4 })).toBe(true);
  });
  it("returns when the round is unknown (out of combat, or an unstamped start)", () => {
    expect(seizureReturnDue({ ...auto, startRound: null, round: 4 })).toBe(true);
    expect(seizureReturnDue({ ...auto, startRound: 3, round: undefined })).toBe(true);
  });
  it("never auto-returns a manual seizure", () => {
    expect(seizureReturnDue({ seized: true, auto: false, startRound: 1, round: 5 })).toBe(false);
    expect(seizureReturnDue({ seized: true, auto: false, force: true })).toBe(false);
  });
  it("does nothing when no seizure is running", () => {
    expect(seizureReturnDue({ seized: false, auto: true, startRound: 1, round: 5 })).toBe(false);
    expect(seizureReturnDue({ seized: false, auto: true, force: true })).toBe(false);
  });
  it("force overrides the round check for an auto seizure (combat deleted mid-hold)", () => {
    expect(seizureReturnDue({ ...auto, startRound: 3, round: 3, force: true })).toBe(true);
    expect(seizureReturnDue({ ...auto, startRound: 3, round: null, force: true })).toBe(true);
  });
  it("survives junk input", () => {
    expect(seizureReturnDue()).toBe(false);
    expect(seizureReturnDue({})).toBe(false);
  });
});
