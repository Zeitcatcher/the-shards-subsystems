/**
 * Pure Ansu model: tiers, level clamping, the Call and release DCs, Communion
 * lengths by Call degree, loyalty and wrath, deeds and the night's rest. The
 * Climb is gone (rework step E). No Foundry imports, vitest-covered.
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

/**
 * May the Tenth Step fork be opened for this state?
 *
 * The fork is the last rung of the ladder, not a shortcut: only a bearer sitting
 * at attunement 9 may choose Mastery or Taken through it, and a terminal has
 * already chosen. Taken at ANY attunement is a separate door (the panel footer),
 * because the Ansu does not have to wait for the bearer to climb. (0.6.6)
 *
 * @param {{terminal: unknown, level: number}} state
 */
export function forkAllowed({ terminal, level } = {}) {
  if (terminal) return false;
  return clampLevel(level) >= MAX_LEVEL - 1;
}

/* ================================================================== */
/* Rework 0.8 (step A): loyalty, wrath, degrees, lockouts, the blade.   */
/* ================================================================== */

/** Loyalty scale bounds (default 5) and wrath bounds (default 0). */
export const LOYALTY_MAX = 10;
export const LOYALTY_DEFAULT = 5;
export const WRATH_MAX = 6;

function int(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp a loyalty value to 0..10 (non-numbers fall back to the default 5). */
export function clampLoyalty(v) {
  return Math.max(0, Math.min(LOYALTY_MAX, int(v, LOYALTY_DEFAULT)));
}

/** Clamp a wrath value to 0..6 (non-numbers fall back to 0). */
export function clampWrath(v) {
  return Math.max(0, Math.min(WRATH_MAX, int(v, 0)));
}

/** Rounds by degree index: 0 critical failure, 1 failure, 2 success, 3 critical success. */
const DURATION_BY_TIER = Object.freeze({
  trial: Object.freeze([0, 1, 3, 10]),
  discipline: Object.freeze([0, 2, 5, 10]),
  union: Object.freeze([0, 3, 10, 100]),
});

/**
 * Communion rounds for a Call at `level` with the Athletics degree (0..3).
 * Level 0: 0 (nothing to call). Level 10: null (permanent, no Call).
 */
export function durationRoundsFor(level, degree) {
  const l = clampLevel(level);
  if (l < 1) return 0;
  if (l >= MAX_LEVEL) return null;
  const d = Math.max(0, Math.min(3, int(degree, 0)));
  return DURATION_BY_TIER[tierForLevel(l).id][d];
}

/** Loyalty band: 0 hostile, 1-3 cold, 4-6 wary, 7-10 trust. */
export function loyaltyBand(v) {
  const l = clampLoyalty(v);
  if (l === 0) return "hostile";
  if (l <= 3) return "cold";
  if (l <= 6) return "wary";
  return "trust";
}

const CALL_ADJUST = Object.freeze({ hostile: 2, cold: 1, wary: 0, trust: -1 });

/** Call DC adjustment by loyalty band: hostile +2, cold +1, wary 0, trust -1. */
export function callAdjust(loyalty) {
  return CALL_ADJUST[loyaltyBand(loyalty)];
}

function dialInt(v, fallback) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Call DC: base + step x level (uncapped) + callAdjust(loyalty), so the defaults
 * give 20 + 2 x level + adjust. Level 0 counts as 1. The dials (ansuCallBase /
 * ansuCallStep) pass through; junk dials fall back to 20 / 2.
 */
export function callDCFor(level, loyalty, { base = 20, step = 2 } = {}) {
  const n = Math.max(1, clampLevel(level));
  return Math.max(1, dialInt(base, 20) + dialInt(step, 2) * n + callAdjust(loyalty));
}

/**
 * Release DC: base + step x min(level, cap) + returnPenalty (0 or 2), so the
 * defaults give 20 + 2 x min(level, 5) + penalty. Level 0 counts as 1. The
 * dials (ansuDcBase / ansuDcStep / ansuDcCap) pass through.
 */
export function releaseDCFor(level, returnPenalty = 0, { base = 20, step = 2, cap = 5 } = {}) {
  const c = Math.max(1, Math.trunc(Number(cap)) || 5);
  const n = Math.max(1, clampLevel(level));
  return Math.max(1, dialInt(base, 20) + dialInt(step, 2) * Math.min(n, c) + Math.max(0, int(returnPenalty, 0)));
}

/** Wrath band: 0-2 calm, 3-5 angry, 6 breaking. */
export function wrathBand(w) {
  const v = clampWrath(w);
  if (v <= 2) return "calm";
  if (v <= 5) return "angry";
  return "breaking";
}

/** DC by character level 0..20. */
export const LEVEL_DC = Object.freeze([14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40]);

/** Conflict severity adjustments. */
export const SEVERITY_ADJUST = Object.freeze({ minor: 0, serious: 2, betrayal: 5 });

/**
 * Will DC of a conflict of will: LEVEL_DC[charLevel] + severity (minor 0,
 * serious 2, betrayal 5) + 2 when wrath is 3 or more. An unknown severity counts
 * as minor; the character level clamps to 0..20.
 */
export function conflictDC(charLevel, severity, wrath) {
  const cl = Math.max(0, Math.min(20, int(charLevel, 0)));
  const sev = SEVERITY_ADJUST[severity] ?? 0;
  return LEVEL_DC[cl] + sev + (clampWrath(wrath) >= 3 ? 2 : 0);
}

/** Hit Points lost on the release: failure 2 x level, critical failure 4 x level, else 0. */
export function hpLoss(level, degree) {
  const l = clampLevel(level);
  const d = int(degree, 2);
  if (d === 1) return 2 * l;
  if (d <= 0) return 4 * l;
  return 0;
}

/**
 * Lockout after a release: Trial until the next night's rest, Discipline one
 * hour, Union ten minutes. Returns `{seconds, untilRest}`, or null where no
 * release happens (level 0 and level 10).
 */
export function lockoutAfterRelease(level) {
  const l = clampLevel(level);
  if (l < 1 || l >= MAX_LEVEL) return null;
  const tier = tierForLevel(l).id;
  if (tier === "trial") return { seconds: null, untilRest: true };
  if (tier === "discipline") return { seconds: 3600, untilRest: false };
  return { seconds: 600, untilRest: false };
}

/** Lockout after a critically failed Call: one minute. */
export const CALL_CF_LOCKOUT = Object.freeze({ seconds: 60, untilRest: false });

/** Turn a lockout spec into the stored state `{until, untilRest}` at world time `now`. */
export function makeLockout(spec, now) {
  if (!spec) return null;
  const until = spec.seconds == null ? null : int(now, 0) + spec.seconds;
  return { until, untilRest: Boolean(spec.untilRest) };
}

/** Rounds cap of a takeover: min(10, level + 3). */
export function takeoverCap(level) {
  return Math.min(10, clampLevel(level) + 3);
}

/** Highest attunement the character level allows: max(1, floor(charLevel / 2)). */
export function gateMax(charLevel) {
  return Math.max(1, Math.floor(Math.max(0, int(charLevel, 0)) / 2));
}

/* ---------------------------- The bound blade --------------------------- */

const RECALL_RANGE = Object.freeze({ 3: 40, 4: 50, 5: 60, 6: 80, 7: 100, 8: 150, 9: 200, 10: 300 });
const RECALLS = Object.freeze({ 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 3, 9: 4 });

/** Recall range in feet; 0 below level 3. */
export function recallRange(level) {
  return RECALL_RANGE[clampLevel(level)] ?? 0;
}

/** Recalls; +1 in the trust band; Infinity (unlimited) at level 10; 0 below level 3. */
export function recalls(level, loyalty) {
  const l = clampLevel(level);
  if (l >= MAX_LEVEL) return Infinity;
  const base = RECALLS[l] ?? 0;
  if (!base) return 0;
  return base + (loyaltyBand(loyalty) === "trust" ? 1 : 0);
}

/** Thrown range increment in feet: Trial 30, Discipline 40, Union 60, level 10 80; 0 at level 0. */
export function throwIncrement(level) {
  const l = clampLevel(level);
  if (l < 1) return 0;
  if (l >= MAX_LEVEL) return 80;
  return { trial: 30, discipline: 40, union: 60 }[tierForLevel(l).id];
}

/* ------------------------------- Deeds ---------------------------------- */

/**
 * Apply one deed (an entry of data/ansu/deeds.json) to an Ansu state.
 * Loyalty moves by `deed.loyalty`; wrath moves by `deed.wrath` or is set to
 * `deed.wrathSet`; `deed.wrathSkipAtLoyalty0` skips the wrath move when loyalty
 * before the deed is 0. Both clamp. Then the level-up check: loyalty 10, level
 * below 9 and below gateMax(charLevel), wrath 2 or less, no terminal: level + 1,
 * loyalty 5, wrath 0. Level 9 never rises here (the fork stays a GM action).
 * `holdLevel` skips the check: a takeover holds the level-up until the return.
 *
 * Pure: returns `{state, leveled, loyalty:[from,to], wrath:[from,to], level:[from,to]}`
 * and never mutates the input.
 */
export function applyDeed(state, deed, { charLevel, holdLevel = false } = {}) {
  const level0 = clampLevel(state?.level);
  const loy0 = clampLoyalty(state?.loyalty);
  const wr0 = clampWrath(state?.wrath);

  let loy = clampLoyalty(loy0 + int(deed?.loyalty, 0));
  let wr = wr0;
  if (Number.isFinite(deed?.wrathSet)) wr = clampWrath(deed.wrathSet);
  else if (!(deed?.wrathSkipAtLoyalty0 && loy0 === 0)) wr = clampWrath(wr0 + int(deed?.wrath, 0));

  let level = level0;
  let leveled = false;
  if (
    !state?.terminal &&
    // A takeover holds the level-up until the body returns (review ruling 9).
    !holdLevel &&
    // Level 0 never rises through loyalty: the first attunement stays a GM action.
    level0 >= 1 &&
    loy >= LOYALTY_MAX &&
    level0 < MAX_LEVEL - 1 &&
    level0 < gateMax(charLevel) &&
    wr <= 2
  ) {
    level = level0 + 1;
    loy = LOYALTY_DEFAULT;
    wr = 0;
    leveled = true;
  }

  return {
    state: { ...state, level, loyalty: loy, wrath: wr },
    leveled,
    loyalty: [loy0, loy],
    wrath: [wr0, wr],
    level: [level0, level],
  };
}

/**
 * A night's rest: wrath -1 unless loyalty is 0; clears a lockout that lasts
 * until rest (a timed lockout stays); consentUsed back to false. Pure.
 */
export function nightRest(state) {
  const loy = clampLoyalty(state?.loyalty);
  const wr = clampWrath(state?.wrath);
  const lockout = state?.lockout?.untilRest ? null : (state?.lockout ?? null);
  return {
    ...state,
    wrath: loy === 0 ? wr : clampWrath(wr - 1),
    lockout,
    consentUsed: false,
  };
}

/** A Call outcome as a degree 0..3 (CF, F, S, CS), or null for anything else. */
export function degreeOf(outcome) {
  const i = ["criticalFailure", "failure", "success", "criticalSuccess"].indexOf(outcome);
  return i < 0 ? null : i;
}

/** Is a stored lockout running at world time `now`? A rest lockout runs until a rest clears it. */
export function lockoutActive(lockout, now) {
  if (!lockout || typeof lockout !== "object") return false;
  if (lockout.untilRest === true) return true;
  const until = Number(lockout.until);
  return Number.isFinite(until) && int(now, 0) < until;
}

/**
 * Why an Invoke (the Call) may not start now, as a reason key, or null when it
 * may. Checked in this order: seized, a release card still waiting for its roll,
 * locked out, Fatigued. A pending Call never blocks (step B ruling): the fresh
 * Invoke replaces it. The caller passes `pendingRelease` only while no
 * Communion runs (review ruling 1).
 */
export function invokeBlock({ seized = false, pendingRelease = null, lockout = null, now = 0, fatigued = false } = {}) {
  if (seized) return "seized";
  if (pendingRelease) return "release";
  if (lockoutActive(lockout, now)) return "lockout";
  if (fatigued) return "fatigued";
  return null;
}
