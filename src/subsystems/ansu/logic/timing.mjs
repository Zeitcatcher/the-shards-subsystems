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

/** The roll option every module-posted Release save carries. */
export const RELEASE_OPTION = "shards-ansu-release";

/** Prefix of the per-card id option that ties a roll to its pending marker. */
export const RELEASE_ID_PREFIX = "shards-ansu-release-id:";

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
 * Does this rolled save count as the answer to the open Release?
 *
 * The module's own roll option is required: an off-card save (a Fortitude save
 * against a poison at the same DC) must never be captured, so there is no fuzzy
 * DC or timing fallback. The card id is preferred but not required — a duplicate
 * or replaced card still carries a real roll from a real player, and dropping it
 * on the floor is what left the wrestle stuck. `idMatch` false is the caller's
 * cue to warn.
 *
 * @param {{options: string[], pendingId: string|null}} input
 * @returns {{accept: boolean, idMatch: boolean, rolledId: string|null}}
 */
export function acceptReleaseRoll({ options, pendingId } = {}) {
  const opts = Array.isArray(options) ? options : [];
  const tagged = opts.find((o) => typeof o === "string" && o.startsWith(RELEASE_ID_PREFIX));
  const rolledId = tagged ? tagged.slice(RELEASE_ID_PREFIX.length) : null;
  const accept = opts.includes(RELEASE_OPTION) && Boolean(pendingId);
  return { accept, idMatch: accept && rolledId === pendingId, rolledId };
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

/**
 * Does an auto seizure hand the body back now? The caller has already
 * established that the bearer's turn just ended (or passes `force`, for a combat
 * deleted mid-hold). "1 round" means the end of the bearer's NEXT turn, and a
 * combatant acts once per round, so the return round is always later than the
 * one the seizure began in — the starting turn's own end must not cancel it.
 */
export function seizureReturnDue({ seized, auto, startRound, round, force } = {}) {
  if (!seized || !auto) return false;
  if (force) return true;
  const start = Number(startRound);
  const now = Number(round);
  if (Number.isFinite(start) && Number.isFinite(now) && now <= start) return false;
  return true;
}
