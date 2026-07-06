/**
 * Pure Izir model: tiers, level clamping, temptation DC. No Foundry imports — this is
 * the vitest-covered heart of the numeric design.
 */

export const MAX_LEVEL = 10;

/**
 * The four tiers plus the level-0 "marked" state and the level-10 terminal band.
 * `id` doubles as a CSS accent class (tier-<id>).
 */
export const TIERS = Object.freeze([
  { id: "marked", min: 0, max: 0, nameKey: "SHARDS.Izir.Tier.marked" },
  { id: "whisper", min: 1, max: 3, nameKey: "SHARDS.Izir.Tier.whisper" },
  { id: "grip", min: 4, max: 6, nameKey: "SHARDS.Izir.Tier.grip" },
  { id: "call", min: 7, max: 9, nameKey: "SHARDS.Izir.Tier.call" },
  { id: "nineveh", min: 10, max: 10, nameKey: "SHARDS.Izir.Tier.nineveh" },
]);

/** Coerce any input to an integer immersion level in [0, MAX_LEVEL]. */
export function clampLevel(level) {
  const n = Math.trunc(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_LEVEL, n));
}

/** The tier band a level falls in. */
export function tierForLevel(level) {
  const l = clampLevel(level);
  return TIERS.find((t) => l >= t.min && l <= t.max) ?? TIERS[0];
}

/**
 * Temptation-save DC. Default design: 14 + 2×immersion, both dials configurable.
 * Clamped to a sane floor so a mis-set base can't produce a negative DC.
 */
export function dcFor(level, base = 14, step = 2) {
  const b = Math.trunc(Number(base));
  const s = Math.trunc(Number(step));
  const dc = (Number.isFinite(b) ? b : 14) + (Number.isFinite(s) ? s : 2) * clampLevel(level);
  return Math.max(1, dc);
}
