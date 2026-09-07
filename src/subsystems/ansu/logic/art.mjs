/**
 * Pure art helpers (Ansu horn stages: broken → regrowing at 4 → whole at 7 →
 * Salbarium at 10): which threshold a level unlocks, and where an actor's token
 * art actually lives. No Foundry — unit-tested.
 */

const THRESHOLDS = [10, 7, 4];

/**
 * The token art an actor is wearing right now.
 *
 * A synthetic (unlinked token) actor has no meaningful prototype token — its art
 * lives on the placed token document — so reading `prototypeToken` there
 * captured the base statblock's art and a revert put the wrong picture back. (C6)
 */
export function currentTokenSrc(actor) {
  return actor?.isToken ? actor.token?.texture?.src : actor?.prototypeToken?.texture?.src;
}

/** Does a threshold slot have any art configured? */
function hasArt(slot) {
  return Boolean(slot && (slot.portrait || slot.token));
}

/** Highest configured threshold <= level, as a string key, or null. */
export function pickThresholdForLevel(level, thresholds) {
  for (const k of THRESHOLDS) {
    if (level >= k && hasArt(thresholds?.[k])) return String(k);
  }
  return null;
}
