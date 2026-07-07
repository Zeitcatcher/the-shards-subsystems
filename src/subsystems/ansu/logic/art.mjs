/**
 * Pure art-threshold selection (Ansu horn stages: broken → regrowing at 4 →
 * whole at 7 → Salbarium at 10). Given a level and the configured threshold
 * slots, pick the highest threshold whose art is set. No Foundry — unit-tested.
 */

const THRESHOLDS = [10, 7, 4];

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
