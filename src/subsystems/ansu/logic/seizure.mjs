/**
 * Pure seizure bookkeeping: what a seizure puts away, what comes back out, and
 * how the takeovers of 0.8 count down. No Foundry imports.
 *
 * Kinds (0.8):
 * - "manual"  the GM's own button: holds until the GM hands the body back, and
 *             the snapshot comes back whole.
 * - "forced"  a lost conflict of will with a calm or angry Ansu: returns at a
 *             bearer turn end (1 or 2 of them), restoring the snapshot, so a
 *             running Communion resumes with the rounds it had left.
 * - "berserk" a lost conflict at breaking point: no auto return; a Will check at
 *             each bearer turn end, or unconsciousness, ends it. Lands dormant.
 * - "agreed"  the bearer lets the Ansu in: runs a number of bearer turns, then
 *             lands dormant and the release card goes up.
 */

export const SEIZURE_KINDS = Object.freeze(["manual", "forced", "berserk", "agreed"]);

/**
 * The blob a seizure stores. Every pending roll goes in here, because the same
 * patch clears them: a card the player still has open must survive the hold and
 * be clickable again afterwards. `roundsLeft` (when known) replaces the stamped
 * Communion length, so a restored Communion resumes rather than restarting.
 */
export function seizureSnapshot(state = {}, { roundsLeft = null } = {}) {
  let communion = state.communion;
  if (communion && communion.mode === "active" && Number.isFinite(roundsLeft) && roundsLeft >= 1) {
    communion = { ...communion, rounds: Math.trunc(roundsLeft) };
  }
  return {
    level: state.level,
    climb: state.climb,
    terminal: state.terminal,
    communion,
    pendingRelease: state.pendingRelease ?? null,
    pendingCall: state.pendingCall ?? null,
  };
}

/** The kind of a stored seizure. One stored before 0.8 reads as `auto ? "forced" : "manual"`. */
export function seizureKind(seizure) {
  if (!seizure || typeof seizure !== "object") return null;
  if (SEIZURE_KINDS.includes(seizure.kind)) return seizure.kind;
  return seizure.auto ? "forced" : "manual";
}

/**
 * Where handing the body back lands the bearer:
 * - "snapshot" exactly where they were (manual, forced),
 * - "dormant"  no Communion (berserk),
 * - "release"  no Communion and the release card goes up (agreed).
 * Null when nothing holds the body.
 */
export function seizureLanding(state) {
  const s = state ?? {};
  if (s.communion?.mode !== "seized") return null;
  const kind = seizureKind(s.seizure);
  if (kind === "berserk") return "dormant";
  if (kind === "agreed") return "release";
  return "snapshot";
}

/**
 * Which pending rolls come back on Return. A snapshot landing hands back the
 * same cards, ids and all. A dormant or release landing drops them: the Call was
 * answered by the takeover and a release is posted fresh where one is owed.
 */
export function restoredPendings({ snapshot, landing = "snapshot" } = {}) {
  if (landing === "dormant" || landing === "release") return { pendingRelease: null, pendingCall: null };
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    pendingRelease: snap.pendingRelease ?? null,
    pendingCall: snap.pendingCall ?? null,
  };
}

/**
 * The takeover a failed Will save in a conflict of will starts, by wrath band:
 * calm returns at the next bearer turn end (then `vented-1`), angry one turn end
 * later (then `vented-2`), breaking goes berserk (then `berserk-end`).
 */
export function takeoverPlan(band) {
  if (band === "breaking") return { kind: "berserk", turnsLeft: null, deed: "berserk-end" };
  if (band === "angry") return { kind: "forced", turnsLeft: 2, deed: "vented-2" };
  return { kind: "forced", turnsLeft: 1, deed: "vented-1" };
}

/**
 * One of the bearer's turns ended while the Ansu holds the body.
 *
 * `skipTurnEnd` marks a takeover that began during the bearer's own turn: that
 * turn's end does not count, so "the next turn end" is the end of the next turn
 * and the Ansu always gets one. It is consumed here.
 *
 * Returns `{turnsLeft, skipTurnEnd, due, check}`: `due` hands the body back now
 * (forced, agreed), `check` posts the berserk Will check. Manual never moves.
 */
export function takeoverTurnEnd({ kind, turnsLeft = null, skipTurnEnd = false } = {}) {
  const left = Number.isFinite(Number(turnsLeft)) && turnsLeft !== null ? Math.trunc(Number(turnsLeft)) : null;
  const idle = { turnsLeft: left, skipTurnEnd: false, due: false, check: false };
  if (kind !== "forced" && kind !== "agreed" && kind !== "berserk") return { ...idle, skipTurnEnd: Boolean(skipTurnEnd) };
  if (skipTurnEnd) return idle;
  if (kind === "berserk") return { ...idle, check: true };
  const next = Math.max(0, (left ?? 1) - 1);
  return { turnsLeft: next, skipTurnEnd: false, due: next <= 0, check: false };
}

/**
 * Does a combat ending hand the body back? Forced and agreed takeovers count
 * bearer turns, and none come once the fight is gone, so they return. Berserk
 * and manual wait for the GM's hand-back.
 */
export function returnsOnCombatEnd(kind) {
  return kind === "forced" || kind === "agreed";
}
