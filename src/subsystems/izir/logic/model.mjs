/**
 * Pure Izir model: tiers, level clamping, the caster-anchored casting stat, the
 * temptation DC, and the slide (progress toward the next immersion level).
 * No Foundry imports — this is the vitest-covered heart of the numeric design.
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

/* ------------------------------------------------------------------ */
/* Casting — anchored to a standard caster of the character's level.   */
/* ------------------------------------------------------------------ */

/**
 * A typical PC caster's spell-attack bonus at a character level: key attribute
 * (+4, +5 at 10, +6 at 17) plus proficiency (trained → expert 7 → master 15 →
 * legendary 19).
 */
export function casterBaselineAttack(charLevel) {
  const l = Math.max(1, Math.min(20, Math.trunc(Number(charLevel)) || 1));
  const attr = l >= 17 ? 6 : l >= 10 ? 5 : 4;
  const prof = l >= 19 ? 8 : l >= 15 ? 6 : l >= 7 ? 4 : 2;
  return attr + prof + l;
}

/**
 * Izir spell attack: equal to a true caster at immersion 5, shifted ±1 per
 * immersion level around that anchor. At immersion 0 there is no casting.
 */
export function izirAttack(charLevel, immersion) {
  return casterBaselineAttack(charLevel) + (clampLevel(immersion) - 5);
}

/** Izir power DC = 10 + Izir attack. */
export function izirDC(charLevel, immersion) {
  return 10 + izirAttack(charLevel, immersion);
}

/* ------------------------------------------------------------------ */
/* Temptation DC.                                                      */
/* ------------------------------------------------------------------ */

/**
 * Temptation-save DC: 20 at immersion 1, +3 per level (both dials configurable).
 * Clamped to a sane floor so a mis-set base can't produce a nonsense DC.
 */
export function dcFor(level, base = 20, step = 3) {
  const b = Math.trunc(Number(base));
  const s = Math.trunc(Number(step));
  const n = Math.max(1, clampLevel(level));
  const dc = (Number.isFinite(b) ? b : 20) + (Number.isFinite(s) ? s : 3) * (n - 1);
  return Math.max(1, dc);
}

/* ------------------------------------------------------------------ */
/* The slide — progress toward the next immersion level.               */
/* ------------------------------------------------------------------ */

/** Points needed to rise from `level` to `level + 1` (3 × current level). */
export function slideNeeded(level) {
  const l = clampLevel(level);
  if (l < 1 || l >= MAX_LEVEL) return 0;
  return 3 * l;
}

/** Slide delta for a temptation outcome: fail +1, crit fail +2, success holds. */
export function slideDeltaFor(outcome) {
  if (outcome === "failure") return 1;
  if (outcome === "criticalFailure") return 2;
  return 0;
}

/**
 * Apply a slide delta (or an absolute set via `{ set }`): overflow carries the
 * level upward; a full bar at immersion 9 does NOT enter 10 — it caps and raises
 * `atTenth` so the GM chooses the fork. Level 0 has no slide.
 *
 * @param {number} level      current immersion (0..10)
 * @param {number} slide      current slide points
 * @param {number} delta      points to add (may be negative)
 * @param {object} [opts]     { set: absoluteValue } overrides delta
 * @returns {{level:number, slide:number, leveled:boolean, atTenth:boolean}}
 */
export function applySlide(level, slide, delta, opts = {}) {
  let l = clampLevel(level);
  if (l < 1 || l >= MAX_LEVEL) return { level: l, slide: 0, leveled: false, atTenth: false };

  let s = Number.isFinite(opts.set) ? Math.trunc(opts.set) : (Math.trunc(Number(slide)) || 0) + Math.trunc(Number(delta) || 0);
  s = Math.max(0, s);

  let leveled = false;
  while (l < MAX_LEVEL - 1 && s >= slideNeeded(l)) {
    s -= slideNeeded(l);
    l += 1;
    leveled = true;
  }

  let atTenth = false;
  if (l === MAX_LEVEL - 1 && s >= slideNeeded(l)) {
    s = slideNeeded(l); // cap: the fork is a GM decision, never automatic
    atTenth = true;
  }
  return { level: l, slide: s, leveled, atTenth };
}
