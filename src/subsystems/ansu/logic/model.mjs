/**
 * Pure Ansu model: tiers, level clamping, the Release DC (GM formula B: grows to
 * attunement 5, frozen after), communion durations by tier, and the Climb (progress
 * toward the next attunement — the inverse of Izir's slide: it fills on CONTROL,
 * not on failure). No Foundry imports — vitest-covered.
 */

export const MAX_LEVEL = 10;

/**
 * The four tiers plus the level-0 "attuned" state. `id` doubles as a CSS accent
 * class (tier-<id>); the terminal displays ("subjugated" / "taken") are separate
 * states layered on top by displayTier.
 */
export const TIERS = Object.freeze([
  { id: "attuned", min: 0, max: 0, nameKey: "SHARDS.Ansu.Tier.attuned" },
  { id: "trial", min: 1, max: 3, nameKey: "SHARDS.Ansu.Tier.trial" },
  { id: "discipline", min: 4, max: 6, nameKey: "SHARDS.Ansu.Tier.discipline" },
  { id: "union", min: 7, max: 9, nameKey: "SHARDS.Ansu.Tier.union" },
  { id: "mastery", min: 10, max: 10, nameKey: "SHARDS.Ansu.Tier.mastery" },
]);

/** Coerce any input to an integer attunement level in [0, MAX_LEVEL]. */
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
/* Release DC — formula B, frozen from the cap onward.                  */
/* ------------------------------------------------------------------ */

/**
 * Will-save DC to end Communion: base + step × min(attunement, cap).
 * Defaults (GM decision, rev 3): 20 + 2 × min(N, 5) → 22 / 24 / 26 / 28 / 30.
 * Level 0 is treated as 1; at attunement 10 no save is ever rolled (callers gate).
 */
export function releaseDC(level, base = 20, step = 2, cap = 5) {
  const b = Number.isFinite(Math.trunc(Number(base))) ? Math.trunc(Number(base)) : 20;
  const s = Number.isFinite(Math.trunc(Number(step))) ? Math.trunc(Number(step)) : 2;
  const c = Math.max(1, Math.trunc(Number(cap)) || 5);
  const n = Math.max(1, clampLevel(level));
  return Math.max(1, b + s * Math.min(n, c));
}

/* ------------------------------------------------------------------ */
/* Communion duration by tier.                                          */
/* ------------------------------------------------------------------ */

/**
 * Rounds of Communion per invocation: 1 (Trial) / 3 (Discipline) / 10 = one minute
 * (Union). Returns null at 10 (permanent — Mastery has no duration) and 0 at
 * attunement 0 (no Communion to invoke yet).
 */
export function durationRounds(level) {
  const l = clampLevel(level);
  if (l < 1) return 0;
  if (l <= 3) return 1;
  if (l <= 6) return 3;
  if (l <= 9) return 10;
  return null;
}

/* ------------------------------------------------------------------ */
/* Numbers baked into rule elements.                                    */
/* ------------------------------------------------------------------ */

/** Temporary Hit Points granted on invoke: 3 × attunement. */
export function tempHpFor(level) {
  return 3 * Math.max(1, clampLevel(level));
}

/** Salbarine Skin physical resistance: ⌈attunement / 2⌉ (3 at 5, 4 at 7, 5 at 9). */
export function resistFor(level) {
  return Math.ceil(Math.max(1, clampLevel(level)) / 2);
}

/** Salbarine Parry: resistance against one triggering attack = 2 × attunement. */
export function parryFor(level) {
  return 2 * Math.max(1, clampLevel(level));
}

/** Maker's Wrath extra dice: one d6 per tier (Trial 1 / Discipline 2 / Union+ 3). */
export function tierDiceFor(level) {
  const l = Math.max(1, clampLevel(level));
  if (l <= 3) return 1;
  if (l <= 6) return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* The Climb — progress toward the next attunement level.               */
/* ------------------------------------------------------------------ */

/** Points needed to rise from `level` to `level + 1`: base + step × level (2 + N). */
export function climbNeeded(level, base = 2, step = 1) {
  const l = clampLevel(level);
  if (l < 1 || l >= MAX_LEVEL) return 0;
  const b = Number.isFinite(Math.trunc(Number(base))) ? Math.trunc(Number(base)) : 2;
  const s = Number.isFinite(Math.trunc(Number(step))) ? Math.trunc(Number(step)) : 1;
  return Math.max(1, b + s * l);
}

/** Climb delta for a release outcome: clean +1, critical +2 — failures hold. */
export function climbDeltaFor(outcome) {
  if (outcome === "criticalSuccess") return 2;
  if (outcome === "success") return 1;
  return 0;
}

/**
 * Apply a climb delta (or an absolute set via `{ set }`): overflow carries the
 * level upward; a full bar at attunement 9 does NOT enter 10 — it caps and raises
 * `atTenth` so the GM chooses the fork (Mastery / Taken). Level 0 has no climb.
 *
 * @param {number} level      current attunement (0..10)
 * @param {number} climb      current climb points
 * @param {number} delta      points to add (may be negative)
 * @param {object} [opts]     { set: absoluteValue } overrides delta; { base, step } dials
 * @returns {{level:number, climb:number, leveled:boolean, atTenth:boolean}}
 */
export function applyClimb(level, climb, delta, opts = {}) {
  let l = clampLevel(level);
  if (l < 1 || l >= MAX_LEVEL) return { level: l, climb: 0, leveled: false, atTenth: false };

  const needed = (lvl) => climbNeeded(lvl, opts.base, opts.step);
  let c = Number.isFinite(opts.set) ? Math.trunc(opts.set) : (Math.trunc(Number(climb)) || 0) + Math.trunc(Number(delta) || 0);
  c = Math.max(0, c);

  let leveled = false;
  while (l < MAX_LEVEL - 1 && c >= needed(l)) {
    c -= needed(l);
    l += 1;
    leveled = true;
  }

  let atTenth = false;
  if (l === MAX_LEVEL - 1 && c >= needed(l)) {
    c = needed(l); // cap: the fork is a GM decision, never automatic
    atTenth = true;
  }
  return { level: l, climb: c, leveled, atTenth };
}
