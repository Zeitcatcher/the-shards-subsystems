/**
 * Pure seizure bookkeeping: what a seizure puts away, and what comes back out.
 *
 * The Ansu taking the body freezes the whole subsystem state and hands it back
 * on Return — so the field list is the contract, and forgetting one field is how
 * a Call rolled during a manual seizure got consumed with no effect. No Foundry
 * imports.
 */

/**
 * The blob a seizure stores. Every pending roll goes in here, because the same
 * patch clears them: a card the player still has open must survive the hold and
 * be clickable again afterwards, not resolve into a state that no longer exists.
 */
export function seizureSnapshot(state = {}) {
  return {
    level: state.level,
    climb: state.climb,
    terminal: state.terminal,
    communion: state.communion,
    pendingRelease: state.pendingRelease ?? null,
    pendingCall: state.pendingCall ?? null,
  };
}

/**
 * Which pending rolls come back on Return.
 *
 * A plain Return restores the snapshot exactly — the same cards, the same ids,
 * still clickable. The auto variants land in a state the snapshot's cards no
 * longer describe: "active" starts a fresh Communion (a Call is already answered
 * and a Release is not owed yet) and "lingering" owes a new save at the end of
 * the turn, which `handleTurnEnd` posts. Both drop the stale pair.
 *
 * @param {{snapshot: object|null|undefined, toMode: string|null}} input
 * @returns {{pendingRelease: object|null, pendingCall: object|null}}
 */
export function restoredPendings({ snapshot, toMode } = {}) {
  if (toMode === "active" || toMode === "lingering") return { pendingRelease: null, pendingCall: null };
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    pendingRelease: snap.pendingRelease ?? null,
    pendingCall: snap.pendingCall ?? null,
  };
}

/**
 * Where pressing Return actually lands the bearer, or null for "exactly where
 * they were".
 *
 * A manual seizure restores the snapshot whole. An auto one deliberately lands
 * in its `thenMode` and drops the snapshot's Communion, so the panel's single
 * tooltip promising "the exact pre-seizure state" was wrong for two of the three
 * cases. The Return handler and the tooltip read the same answer from here so
 * they cannot disagree again. (0.6.6)
 *
 * @returns {"active"|"lingering"|null}
 */
export function seizeReturnsTo(state) {
  const s = state ?? {};
  if (!s.seizure?.auto) return null;
  return s.seizure.thenMode === "active" ? "active" : "lingering";
}
