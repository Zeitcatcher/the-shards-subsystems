import { describe, it, expect } from "vitest";
import {
  sweepHandlesExpiry,
  classifyCommunionDelete,
  acceptReleaseRoll,
  acceptCallRoll,
  communionLooksExpired,
  turnEndReleaseDue,
  seizureReturnDue,
  acceptRerollCapture,
  rerollTransition,
  endedRoundOf,
  roundRolledOver,
  freshClockStart,
  roundsLeftFrom,
  durationUpdateFor,
  RELEASE_OPTION,
  RELEASE_ID_PREFIX,
  CALL_OPTION,
  CALL_ID_PREFIX,
  REROLL_OPTION,
  REROLL_WINDOW_MS,
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

/**
 * The Call used to demand an exact id match and drop everything else in silence,
 * so a bearer who rolled the older of two live cards spent the action for
 * nothing. It runs through the same private helper as the Release now, which is
 * what stops the two paths drifting apart again. (item 15)
 */
describe("acceptCallRoll", () => {
  const id = "call77";
  const withId = (v) => [CALL_OPTION, `${CALL_ID_PREFIX}${v}`];

  it("accepts the matching card", () => {
    expect(acceptCallRoll({ options: withId(id), pendingId: id })).toEqual({
      accept: true,
      idMatch: true,
      rolledId: id,
    });
  });
  it("accepts a superseded card and reports the mismatch for the warning", () => {
    expect(acceptCallRoll({ options: withId("stale42"), pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: "stale42",
    });
  });
  it("accepts a tagged roll carrying no id at all", () => {
    expect(acceptCallRoll({ options: [CALL_OPTION], pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: null,
    });
  });
  it("never captures a foreign skill check at the same DC", () => {
    const foreign = ["action:demoralize", "check:statistic:athletics", "dc:26"];
    expect(acceptCallRoll({ options: foreign, pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: null,
    });
  });
  it("never captures a stray id option without our roll option", () => {
    expect(acceptCallRoll({ options: [`${CALL_ID_PREFIX}${id}`], pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: id,
    });
  });
  it("has nothing to capture with no open Call", () => {
    expect(acceptCallRoll({ options: withId(id), pendingId: null })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: id,
    });
  });
  it("never answers a Release card, and the Release never answers a Call", () => {
    expect(acceptCallRoll({ options: [RELEASE_OPTION, `${RELEASE_ID_PREFIX}${id}`], pendingId: id }).accept).toBe(false);
    expect(acceptReleaseRoll({ options: withId(id), pendingId: id }).accept).toBe(false);
  });
  it("survives missing or junk options", () => {
    expect(acceptCallRoll()).toEqual({ accept: false, idMatch: false, rolledId: null });
    expect(acceptCallRoll({ options: null, pendingId: id })).toEqual({
      accept: false,
      idMatch: false,
      rolledId: null,
    });
    expect(acceptCallRoll({ options: [undefined, 3, CALL_OPTION], pendingId: id })).toEqual({
      accept: true,
      idMatch: false,
      rolledId: null,
    });
  });
});

/**
 * With pf2e's auto-removal off and no turn change coming, the world-time sweep
 * is the only thing that ever resolves an expiry. `remainingDuration.expired` is
 * the live read; `system.expired` only moves on an actor data reset. (item 19)
 */
describe("communionLooksExpired", () => {
  it("takes any one of the three signals", () => {
    expect(communionLooksExpired({ remainingExpired: true })).toBe(true);
    expect(communionLooksExpired({ isExpired: true })).toBe(true);
    expect(communionLooksExpired({ systemExpired: true })).toBe(true);
  });
  it("is false while the countdown is still running", () => {
    expect(communionLooksExpired({ remainingExpired: false, isExpired: false, systemExpired: false })).toBe(false);
  });
  it("treats a missing or unreadable signal as no expiry, never as one", () => {
    expect(communionLooksExpired()).toBe(false);
    expect(communionLooksExpired({})).toBe(false);
    expect(communionLooksExpired({ remainingExpired: undefined, isExpired: null })).toBe(false);
  });
  it("demands a real true: a truthy value is not an expiry", () => {
    expect(communionLooksExpired({ remainingExpired: "true", isExpired: 1, systemExpired: {} })).toBe(false);
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
  it("holds when the bearer acts LAST and the tracker has already rolled over", () => {
    // The turn that ended belonged to round 2 even though the tracker shows 3.
    // This is the value the endTurn hook now feeds in. (0.6.6)
    const ended = endedRoundOf({
      combatant: { flags: { pf2e: { roundOfLastTurnEnd: 2 } } },
      encounter: { round: 3 },
    });
    expect(seizureReturnDue({ ...auto, startRound: 2, round: ended })).toBe(false);
    // and the old reading — the live round — is exactly what returned it early
    expect(seizureReturnDue({ ...auto, startRound: 2, round: 3 })).toBe(true);
  });
});

describe("endedRoundOf", () => {
  it("prefers pf2e's own roundOfLastTurnEnd over the tracker's live round", () => {
    expect(
      endedRoundOf({ combatant: { flags: { pf2e: { roundOfLastTurnEnd: 4 } } }, encounter: { round: 5 } }),
    ).toBe(4);
  });
  it("falls back to the encounter's previous round when the flag is missing", () => {
    expect(endedRoundOf({ combatant: {}, encounter: { round: 5, previous: { round: 4 } } })).toBe(4);
    expect(
      endedRoundOf({ combatant: { flags: { pf2e: { roundOfLastTurnEnd: null } } }, encounter: { round: 5, previous: { round: 4 } } }),
    ).toBe(4);
  });
  it("falls back to the live round when neither is readable", () => {
    expect(endedRoundOf({ combatant: {}, encounter: { round: 5 } })).toBe(5);
    expect(endedRoundOf({ encounter: { round: 5, previous: {} } })).toBe(5);
  });
  it("reports nothing readable as null, so the caller keeps its own fallback", () => {
    expect(endedRoundOf()).toBeNull();
    expect(endedRoundOf({})).toBeNull();
    expect(endedRoundOf({ combatant: {}, encounter: {} })).toBeNull();
  });
  it("rejects junk round values instead of coercing them", () => {
    expect(endedRoundOf({ combatant: { flags: { pf2e: { roundOfLastTurnEnd: "3" } } }, encounter: { round: 5 } })).toBe(5);
    expect(endedRoundOf({ encounter: { round: Number.NaN } })).toBeNull();
    expect(endedRoundOf({ encounter: { round: "5" } })).toBeNull();
  });
});

describe("roundRolledOver", () => {
  it("is true only when the tracker has moved past the ended turn's round", () => {
    expect(roundRolledOver({ endedRound: 2, currentRound: 3 })).toBe(true);
    expect(roundRolledOver({ endedRound: 2, currentRound: 2 })).toBe(false);
    expect(roundRolledOver({ endedRound: 3, currentRound: 2 })).toBe(false);
  });
  it("treats an unreadable round as no rollover (never shortens a clock)", () => {
    expect(roundRolledOver()).toBe(false);
    expect(roundRolledOver({ endedRound: null, currentRound: 3 })).toBe(false);
    expect(roundRolledOver({ endedRound: 2, currentRound: undefined })).toBe(false);
    expect(roundRolledOver({ endedRound: "2", currentRound: "3" })).toBe(false);
  });
});

describe("freshClockStart", () => {
  it("starts now when the round already rolled over as the turn ended", () => {
    expect(freshClockStart({ worldTime: 120, rolledOver: true })).toBe(120);
  });
  it("starts one round on when the round has not rolled over yet", () => {
    expect(freshClockStart({ worldTime: 120, rolledOver: false })).toBe(126);
    expect(freshClockStart({ worldTime: 120 })).toBe(126);
  });
  it("respects a world with a custom round length", () => {
    expect(freshClockStart({ worldTime: 120, roundTime: 10, rolledOver: false })).toBe(130);
    expect(freshClockStart({ worldTime: 120, roundTime: 10, rolledOver: true })).toBe(120);
  });
  it("survives an unreadable world time or round length", () => {
    expect(freshClockStart()).toBe(6);
    expect(freshClockStart({ worldTime: undefined })).toBe(6);
    expect(freshClockStart({ worldTime: "later", roundTime: "soon" })).toBe(6);
    expect(freshClockStart({ worldTime: 0, rolledOver: true })).toBe(0);
  });
  it("only a hard true counts as rolled over", () => {
    expect(freshClockStart({ worldTime: 120, rolledOver: 1 })).toBe(126);
    expect(freshClockStart({ worldTime: 120, rolledOver: null })).toBe(126);
  });
});

describe("durationUpdateFor", () => {
  it("stamps a fresh clock when a mode change brings a rounds countdown", () => {
    expect(durationUpdateFor({ prevMode: "seized", mode: "active", liveUnit: "unlimited", desiredUnit: "rounds" })).toBe("stamp");
  });
  it("stamps when a fight starts under a Communion that was invoked out of combat", () => {
    expect(durationUpdateFor({ prevMode: "active", mode: "active", liveUnit: "unlimited", desiredUnit: "rounds" })).toBe("stamp");
  });
  it("never re-stamps a clock that is already running (A1)", () => {
    expect(durationUpdateFor({ prevMode: "active", mode: "active", liveUnit: "rounds", desiredUnit: "rounds" })).toBe("strip");
    expect(durationUpdateFor({ prevMode: "active", mode: "active", liveUnit: "rounds", desiredUnit: "unlimited" })).toBe("strip");
    expect(durationUpdateFor({ prevMode: "active", mode: "active", liveUnit: "unlimited", desiredUnit: "unlimited" })).toBe("strip");
  });
  it("keeps a new unlimited duration on a mode change, with no clock to anchor", () => {
    expect(durationUpdateFor({ prevMode: "active", mode: "lingering", liveUnit: "rounds", desiredUnit: "unlimited" })).toBe("keep");
  });
  it("survives junk input by treating it as a same-mode strip", () => {
    expect(durationUpdateFor()).toBe("strip");
    expect(durationUpdateFor({})).toBe("strip");
  });
});

/**
 * pf2e 8.5.0 rerolls a check by DELETING the message and posting a new one built
 * from `fu.deepClone(message.flags.pf2e)` (system/check/check.ts:447), so our own
 * roll option and the card id ride along untouched. It then sets
 * `context.isReroll = true` and pushes "check:reroll" (+ "check:reroll:hero-points")
 * onto `context.options` (:452-454), and it reassigns `context.outcome` ONLY when
 * the new die is the one kept (:549-554) — a keep-higher that kept the old roll
 * posts the ORIGINAL outcome again, and re-applying that would climb twice.
 */
const CARD = "card1";
const rolled = (extra = []) => [RELEASE_OPTION, `${RELEASE_ID_PREFIX}${CARD}`, ...extra];
const recorded = (outcome, at) => ({ id: CARD, dc: 24, outcome, at });

describe("acceptRerollCapture", () => {
  it("takes a rerolled card whose outcome changed, inside the window", () => {
    const r = acceptRerollCapture({
      options: rolled([REROLL_OPTION, "check:reroll:hero-points"]),
      flagged: true,
      last: recorded("criticalFailure", 1000),
      now: 1000 + 30_000,
      outcome: "success",
    });
    expect(r).toMatchObject({ isReroll: true, matchesLast: true, inWindow: true, outcomeChanged: true, accept: true });
    expect(r.rolledId).toBe(CARD);
  });

  it("refuses a reroll that kept the old die: pf2e never reassigned the outcome", () => {
    const r = acceptRerollCapture({
      options: rolled([REROLL_OPTION]),
      flagged: true,
      last: recorded("failure", 1000),
      now: 2000,
      outcome: "failure",
    });
    expect(r.isReroll).toBe(true);
    expect(r.outcomeChanged).toBe(false);
    expect(r.accept).toBe(false);
  });

  it("refuses a card rerolled long after the table moved on", () => {
    const r = acceptRerollCapture({
      options: rolled([REROLL_OPTION]),
      flagged: true,
      last: recorded("criticalFailure", 1000),
      now: 1000 + REROLL_WINDOW_MS + 1,
      outcome: "success",
    });
    expect(r.matchesLast).toBe(true);
    expect(r.inWindow).toBe(false);
    expect(r.accept).toBe(false);
  });

  it("refuses a foreign card id", () => {
    const r = acceptRerollCapture({
      options: [RELEASE_OPTION, `${RELEASE_ID_PREFIX}other`, REROLL_OPTION],
      flagged: true,
      last: recorded("criticalFailure", 1000),
      now: 2000,
      outcome: "success",
    });
    expect(r.matchesLast).toBe(false);
    expect(r.accept).toBe(false);
    expect(r.rolledId).toBe("other");
  });

  it("ignores an ordinary first roll: no reroll marker anywhere on it", () => {
    const r = acceptRerollCapture({
      options: rolled(),
      last: recorded("criticalFailure", 1000),
      now: 2000,
      outcome: "success",
    });
    expect(r.isReroll).toBe(false);
    expect(r.accept).toBe(false);
  });

  it("ignores a rerolled check that is not ours", () => {
    const r = acceptRerollCapture({
      options: ["check:reroll", "action:demoralize"],
      flagged: true,
      last: recorded("criticalFailure", 1000),
      now: 2000,
      outcome: "success",
    });
    expect(r.isReroll).toBe(false);
    expect(r.accept).toBe(false);
  });

  it("takes the flag alone, or the option alone: pf2e writes both", () => {
    const base = { last: recorded("failure", 1000), now: 2000, outcome: "success" };
    expect(acceptRerollCapture({ options: rolled(), flagged: true, ...base }).accept).toBe(true);
    expect(acceptRerollCapture({ options: rolled([REROLL_OPTION]), ...base }).accept).toBe(true);
  });

  it("reads the Call's options when told to", () => {
    const r = acceptRerollCapture({
      options: ["shards-ansu-call", `shards-ansu-call-id:${CARD}`, REROLL_OPTION],
      tag: "shards-ansu-call",
      idPrefix: "shards-ansu-call-id:",
      last: recorded("criticalFailure", 1000),
      now: 2000,
      outcome: "success",
    });
    expect(r.accept).toBe(true);
  });

  it("has nothing to compare against with no recorded roll, and survives junk", () => {
    expect(acceptRerollCapture({ options: rolled([REROLL_OPTION]), last: null, now: 2000, outcome: "success" }).accept).toBe(false);
    expect(acceptRerollCapture().accept).toBe(false);
    expect(acceptRerollCapture({ options: "nonsense" }).accept).toBe(false);
    expect(acceptRerollCapture({ options: [null, 7, REROLL_OPTION] }).rolledId).toBe(null);
  });

  it("never accepts a clock running backwards", () => {
    const r = acceptRerollCapture({
      options: rolled([REROLL_OPTION]),
      last: recorded("failure", 5000),
      now: 1000,
      outcome: "success",
    });
    expect(r.inWindow).toBe(false);
  });
});

describe("rerollTransition", () => {
  it("returns the body before applying a correction to a seized bearer", () => {
    expect(rerollTransition({ mode: "seized", prevOutcome: "criticalFailure", outcome: "success" })).toEqual({
      returnBody: true,
      blocked: false,
    });
  });
  it("applies a correction straight when nothing holds the body", () => {
    expect(rerollTransition({ mode: "lingering", prevOutcome: "failure", outcome: "criticalSuccess" })).toEqual({
      returnBody: false,
      blocked: false,
    });
  });
  it("refuses to walk back a win: that Communion is already played", () => {
    expect(rerollTransition({ mode: "none", prevOutcome: "success", outcome: "failure" }).blocked).toBe(true);
    expect(rerollTransition({ mode: "none", prevOutcome: "criticalSuccess", outcome: "criticalFailure" }).blocked).toBe(true);
  });
  it("lets one win be corrected into another", () => {
    expect(rerollTransition({ mode: "none", prevOutcome: "success", outcome: "criticalSuccess" }).blocked).toBe(false);
  });
  it("survives junk input as an inert plan", () => {
    expect(rerollTransition()).toEqual({ returnBody: false, blocked: false });
  });
});

/**
 * 0 used to mean two different things: an unlimited effect and a Communion in
 * its final round. A template `{{#if}}` reads both as nothing, so the panel's
 * countdown row vanished exactly when the buff was about to end. (item 20)
 */
describe("roundsLeftFrom", () => {
  it("counts a running clock up from pf2e's seconds remaining", () => {
    expect(roundsLeftFrom({ remaining: 18, value: 3, unit: "rounds" })).toBe(3);
    expect(roundsLeftFrom({ remaining: 6, value: 1, unit: "rounds" })).toBe(1);
  });

  it("rounds a part-spent round up: it is still a round the bearer can act in", () => {
    expect(roundsLeftFrom({ remaining: 13, value: 3, unit: "rounds" })).toBe(3);
  });

  it("returns 0 for the final round rather than hiding it", () => {
    expect(roundsLeftFrom({ remaining: 0, value: 1, unit: "rounds" })).toBe(0);
  });

  it("never goes negative when world time has already run past the end", () => {
    expect(roundsLeftFrom({ remaining: -30, value: 1, unit: "rounds" })).toBe(0);
  });

  it("returns null for an unlimited effect, which has no clock to show", () => {
    expect(roundsLeftFrom({ remaining: Infinity, value: -1, unit: "unlimited" })).toBeNull();
    expect(roundsLeftFrom({ remaining: Infinity, value: -1 })).toBeNull();
  });

  it("falls back to the raw duration when pf2e's remaining is unreadable", () => {
    expect(roundsLeftFrom({ remaining: undefined, value: 4, unit: "rounds" })).toBe(4);
    expect(roundsLeftFrom({ remaining: null, value: 0, unit: "rounds" })).toBe(0);
  });

  it("honours a custom round length", () => {
    expect(roundsLeftFrom({ remaining: 30, value: 3, unit: "rounds", roundTime: 10 })).toBe(3);
    expect(roundsLeftFrom({ remaining: 30, value: 3, unit: "rounds", roundTime: 0 })).toBe(5);
  });

  it("returns null on junk input rather than a misleading 0", () => {
    expect(roundsLeftFrom()).toBeNull();
    expect(roundsLeftFrom({})).toBeNull();
    expect(roundsLeftFrom({ remaining: "soon", value: "later" })).toBeNull();
    expect(roundsLeftFrom({ remaining: NaN, value: -1 })).toBeNull();
  });
});
