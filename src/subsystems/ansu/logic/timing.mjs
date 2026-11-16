/**
 * Pure timing rules for the Communion clock: who owns an expiry, what a deleted
 * Communion effect means, when a Release roll counts, and when the end of a turn
 * owes a save or the return of a seized body.
 *
 * Two detectors see the same expiry on the same turn change — our own combat
 * sweep and pf2e's effect tracker deleting the expired item — so the decision of
 * which one acts lives here, out of reach of Foundry globals and unit-tested.
 * No Foundry imports.
 */

import { hpLoss } from "./model.mjs";

/** The roll option every module-posted Release save carries. */
export const RELEASE_OPTION = "shards-ansu-release";

/** Prefix of the per-card id option that ties a roll to its pending marker. */
export const RELEASE_ID_PREFIX = "shards-ansu-release-id:";

/** The roll option every module-posted Call check carries. */
export const CALL_OPTION = "shards-ansu-call";

/** Prefix of the per-card id option on a Call check. */
export const CALL_ID_PREFIX = "shards-ansu-call-id:";

/** The roll option pf2e pushes onto a rerolled check's context. */
export const REROLL_OPTION = "check:reroll";

/**
 * How long after a recorded outcome a rerolled message still counts as its
 * reroll. A hero point is spent while the table is still looking at the card;
 * anything later is a fresh wrestle that happens to reuse an old card id.
 */
export const REROLL_WINDOW_MS = 120_000;

/**
 * Does the combat sweep resolve this expiry itself?
 *
 * With pf2e's `automation.removeEffects` on (its default), pf2e deletes the
 * expired effect moments after our sweep runs, and that delete carries the
 * expiry to us — so the sweep stands down and lets the delete path own it. It
 * gets exactly one sweep of grace: if the effect is still sitting there expired
 * at the next sweep, pf2e is not going to remove it and the sweep steps in.
 * An unreadable setting means the sweep handles it, so an expiry is never lost.
 *
 * @param {unknown} removeEffectsSetting  game.pf2e.settings.automation.removeEffects
 * @param {boolean} seenExpiredBefore     did a previous sweep already see it expired?
 */
export function sweepHandlesExpiry(removeEffectsSetting, seenExpiredBefore) {
  if (removeEffectsSetting !== true) return true;
  return seenExpiredBefore === true;
}

/**
 * What a deleted Communion effect means, given the state at the moment of the
 * delete:
 * - "expiry"  the countdown ran out and nobody has resolved it yet → Release save
 * - "resync"  the sweep already slipped to lingering; pf2e is only clearing the
 *             expired item → recreate the lingering effect, never end the state
 * - "end"     a live effect was deleted on purpose (GM clearing the buff)
 * - "heal"    nothing to decide → plain self-heal resync
 *
 * @param {{terminal: unknown, mode: string, wasExpired: boolean}} input
 * @returns {"expiry"|"resync"|"end"|"heal"}
 */
export function classifyCommunionDelete({ terminal, mode, wasExpired } = {}) {
  if (terminal) return "heal";
  if (wasExpired === true) {
    if (mode === "active") return "expiry";
    if (mode === "lingering") return "resync";
    return "heal";
  }
  if (mode === "active" || mode === "lingering") return "end";
  return "heal";
}

/**
 * Does this rolled check count as the answer to the open card of its kind?
 *
 * The module's own roll option is required: an off-card roll (a Fortitude save
 * against a poison, an Athletics check at the same DC) must never be captured,
 * so there is no fuzzy DC or timing fallback. The card id is preferred but not
 * required — a duplicate or replaced card still carries a real roll from a real
 * player, and dropping it on the floor is what left the wrestle stuck.
 * `idMatch` false is the caller's cue to warn.
 *
 * @param {{options: string[], pendingId: string|null, option: string, idPrefix: string}} input
 * @returns {{accept: boolean, idMatch: boolean, rolledId: string|null}}
 */
function acceptTaggedRoll({ options, pendingId, option, idPrefix }) {
  const opts = Array.isArray(options) ? options : [];
  const tagged = opts.find((o) => typeof o === "string" && o.startsWith(idPrefix));
  const rolledId = tagged ? tagged.slice(idPrefix.length) : null;
  const accept = opts.includes(option) && Boolean(pendingId);
  return { accept, idMatch: accept && rolledId === pendingId, rolledId };
}

/** Does this rolled save answer the open Release card? */
export function acceptReleaseRoll({ options, pendingId } = {}) {
  return acceptTaggedRoll({ options, pendingId, option: RELEASE_OPTION, idPrefix: RELEASE_ID_PREFIX });
}

/**
 * Does this rolled check answer the open Call card? Same rule as the Release,
 * through the same private helper on purpose: the Call used to demand an exact
 * id match and threw everything else away in silence, so a bearer who rolled the
 * older of two live cards spent the action for nothing. (0.6.6)
 */
export function acceptCallRoll({ options, pendingId } = {}) {
  return acceptTaggedRoll({ options, pendingId, option: CALL_OPTION, idPrefix: CALL_ID_PREFIX });
}

/**
 * Does this message carry a hero-point (or any) reroll of an outcome we already
 * recorded, and did the reroll actually change that outcome?
 *
 * pf2e 8.5.0 rerolls by deleting the original message and posting a new one from
 * a DEEP CLONE of its context (check.ts:447), so our own roll option and the
 * card id survive; it sets `context.isReroll` and pushes `check:reroll` onto the
 * options (:452-454), and it overwrites `context.outcome` ONLY when the new die
 * is the one kept (:549-554). The first roll already cleared the pending marker,
 * so nothing downstream would ever look at this message again.
 *
 * An unchanged outcome (keep-higher kept the old die) is deliberately rejected:
 * re-applying it would climb twice for one save.
 *
 * @param {{options: string[], flagged?: boolean, tag?: string, idPrefix?: string,
 *          last?: {id: string, outcome: string, at: number}|null,
 *          now?: number, outcome?: string|null, windowMs?: number}} input
 * @returns {{isReroll: boolean, matchesLast: boolean, inWindow: boolean,
 *            outcomeChanged: boolean, accept: boolean, rolledId: string|null}}
 */
export function acceptRerollCapture({
  options,
  flagged = false,
  tag = RELEASE_OPTION,
  idPrefix = RELEASE_ID_PREFIX,
  last = null,
  now = 0,
  outcome = null,
  windowMs = REROLL_WINDOW_MS,
} = {}) {
  const opts = Array.isArray(options) ? options : [];
  const tagged = opts.find((o) => typeof o === "string" && o.startsWith(idPrefix));
  const rolledId = tagged ? tagged.slice(idPrefix.length) : null;
  const isReroll = opts.includes(tag) && (flagged === true || opts.includes(REROLL_OPTION));

  const lastId = last?.id ?? null;
  const matchesLast = Boolean(lastId) && rolledId === lastId;

  const at = Number(last?.at);
  const span = Number.isFinite(Number(windowMs)) ? Number(windowMs) : REROLL_WINDOW_MS;
  const age = Number(now) - at;
  const inWindow = Number.isFinite(age) && age >= 0 && age <= span;

  const outcomeChanged = Boolean(outcome) && outcome !== (last?.outcome ?? null);

  return {
    isReroll,
    matchesLast,
    inWindow,
    outcomeChanged,
    accept: isReroll && matchesLast && inWindow && outcomeChanged,
    rolledId,
  };
}

/**
 * The release's reroll table (0.8). Every release outcome ends Communion, so a
 * correction never has a Communion to resurrect or a body to hand back; it only
 * settles the costs. Nothing is refunded on its own: Hit Points and Fatigued may
 * have moved since, so the GM is told to restore them by hand.
 *
 * - `hpExtra`     a worse outcome: the further Hit Points it costs (the
 *                 difference between the two losses at this level).
 * - `fatigue`     corrected into a critical failure: Fatigued.
 * - `lockout`     ... and the release lockout.
 * - `liftLockout` a critical failure corrected into anything better: the
 *                 lockout it stamped goes.
 * - `handFix`     a better outcome took Hit Points or Fatigued that the new one
 *                 does not: the GM restores them by hand.
 *
 * @param {{prevOutcome: string|null, outcome: string|null, level: number}} input
 */
export function rerollTransition({ prevOutcome, outcome, level } = {}) {
  const plan = { hpExtra: 0, fatigue: false, lockout: false, liftLockout: false, handFix: false };
  const deg = (o) => ["criticalFailure", "failure", "success", "criticalSuccess"].indexOf(o);
  const p = deg(prevOutcome);
  const n = deg(outcome);
  if (p < 0 || n < 0 || p === n) return plan;
  if (n < p) {
    plan.hpExtra = Math.max(0, hpLoss(level, n) - hpLoss(level, p));
    if (n === 0) {
      plan.fatigue = true;
      plan.lockout = true;
    }
    return plan;
  }
  plan.liftLockout = p === 0;
  plan.handFix = hpLoss(level, p) > hpLoss(level, n) || p === 0;
  return plan;
}

/**
 * The Call's own reroll table (0.8). Critical success, success and failure all
 * grant Communion (they differ in length and in the return penalty); only a
 * critical failure grants none, and it sets a lockout and posts the release.
 *
 * - `blocked`     the recorded outcome granted Communion and the correction
 *                 does not, or the body is held: the GM is told instead.
 * - `restamp`     both grant Communion and it is still running: write the new
 *                 length and return penalty into the state. The live countdown
 *                 is not re-sent (a running clock never is).
 * - `liftLockout` the recorded critical failure is corrected into a grant: the
 *                 lockout and the release card it posted go away.
 * - `invoke`      ... and Communion starts now, from dormant.
 *
 * @param {{mode: string, prevOutcome: string|null, outcome: string|null}} input
 */
export function callRerollTransition({ mode, prevOutcome, outcome } = {}) {
  const grants = (o) => o === "criticalSuccess" || o === "success" || o === "failure";
  const plan = { blocked: false, restamp: false, liftLockout: false, invoke: false };
  if (!outcome || !prevOutcome || outcome === prevOutcome) return plan;
  if (mode === "seized") return { ...plan, blocked: true };
  if (grants(prevOutcome) && !grants(outcome)) return { ...plan, blocked: true };
  if (grants(prevOutcome) && grants(outcome)) {
    if (mode !== "active") return { ...plan, blocked: true };
    return { ...plan, restamp: true };
  }
  if (prevOutcome === "criticalFailure" && grants(outcome)) {
    return { ...plan, liftLockout: true, invoke: (mode ?? "none") === "none" };
  }
  return plan;
}

/**
 * Has the Communion effect run out, as far as any readable signal says?
 *
 * `remainingDuration.expired` is pf2e's live computation against world time;
 * `system.expired` only moves on an actor data reset, and `isExpired` is the
 * item's own getter. Out of combat nothing resets on a schedule, so the live
 * value is the one that catches an encounter that ended mid-Communion — but any
 * of the three saying "expired" is enough. Strict true only: a missing signal is
 * not an expiry.
 */
export function communionLooksExpired({ remainingExpired, isExpired, systemExpired } = {}) {
  return remainingExpired === true || isExpired === true || systemExpired === true;
}

/**
 * Is a fresh Release card owed at the end of this bearer's turn? Only while
 * lingering, and never at a terminal. Active still has its countdown running,
 * seized is the GM's to end, none has nothing to wrestle.
 */
export function turnEndReleaseDue({ mode, terminal } = {}) {
  if (terminal) return false;
  return mode === "lingering";
}

/** A round number only when it really is one — null for a missing or junk value. */
function readRound(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The round the turn that just ended belonged to.
 *
 * Foundry runs turn events after the combat update has landed, so when the LAST
 * combatant's turn ends the tracker already shows the next round, and reading
 * that as the ended turn's round misplaced the returned Communion's clock. pf2e stamps the combatant's own `roundOfLastTurnEnd` in an
 * awaited update immediately before firing `pf2e.endTurn`, so that flag is the
 * honest answer; the encounter's previous round is the fallback. Null means
 * nothing readable — the caller falls back to the live round, unchanged.
 *
 * @returns {number|null}
 */
export function endedRoundOf({ combatant, encounter } = {}) {
  const flagged = readRound(combatant?.flags?.pf2e?.roundOfLastTurnEnd);
  if (flagged !== null) return flagged;
  const previous = readRound(encounter?.previous?.round);
  if (previous !== null) return previous;
  return readRound(encounter?.round);
}

/**
 * Did the round tick over as this turn ended? Only when both numbers are
 * readable and the tracker has moved past the ended turn's round. An unknown
 * round is never a rollover, which keeps the clock compensation conservative:
 * it lengthens a Communion by a round rather than cutting one short.
 */
export function roundRolledOver({ endedRound, currentRound } = {}) {
  const ended = readRound(endedRound);
  const now = readRound(currentRound);
  if (ended === null || now === null) return false;
  return now > ended;
}

/**
 * Where a fresh rounds countdown handed back at a turn end must begin.
 *
 * World time advances one round at a round boundary and pf2e resolves a rounds
 * clock only at a turn START, so a 1-round Communion stamped at a turn end dies
 * at the bearer's very next turn start with no actions taken. If the round
 * already rolled over as this turn ended, the bearer's next turn falls inside
 * the round the tracker now shows and the clock starts now; otherwise it starts
 * one round on. The rollover case reads the clock after the boundary landed —
 * the round's world time is already banked by the time turn events run.
 */
export function freshClockStart({ worldTime, roundTime = 6, rolledOver = false } = {}) {
  const now = Number(worldTime) || 0;
  const round = Number(roundTime) || 6;
  return rolledOver === true ? now : now + round;
}

/**
 * How many rounds a Communion countdown has left, or null when there is no
 * countdown to read.
 *
 * 0 used to mean two different things — an unlimited effect and a Communion in
 * its final round — and a template `{{#if}}` treats both as nothing, so the
 * panel's countdown row disappeared exactly when it mattered most. Null is now
 * "no clock"; 0 is "this is the last round, and the buff ends at the bearer's
 * next turn start".
 *
 * `remaining` is pf2e's own seconds-left figure (Infinity on an unlimited
 * effect); the raw duration value is the fallback, where pf2e writes -1 for
 * "no duration".
 *
 * @param {{remaining: unknown, value: unknown, unit: unknown, roundTime: unknown}} input
 * @returns {number|null}
 */
export function roundsLeftFrom({ remaining, value, unit, roundTime } = {}) {
  if (unit === "unlimited") return null;
  const per = Number(roundTime) || 6;
  const secs = Number(remaining);
  if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs / per));
  const raw = Math.trunc(Number(value));
  if (!Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

/**
 * What an update to the live Communion item must do with its own clock:
 *
 * - "stamp"  write the duration AND a fresh start — a new countdown begins here
 *            (a mode change into rounds, or a fight starting under a Communion
 *            that was invoked out of combat and written unlimited)
 * - "keep"   write the duration, leave start alone — the new duration is
 *            unlimited, so there is no countdown to anchor
 * - "strip"  send neither — the same mode is already running its clock, and pf2e
 *            never re-stamps start on an update, so a duration we sent would read
 *            as expired far in the past and every boon would be ignored (A1)
 */
export function durationUpdateFor({ prevMode, mode, liveUnit, desiredUnit } = {}) {
  if (prevMode === mode) {
    return liveUnit === "unlimited" && desiredUnit === "rounds" ? "stamp" : "strip";
  }
  return desiredUnit === "rounds" ? "stamp" : "keep";
}
