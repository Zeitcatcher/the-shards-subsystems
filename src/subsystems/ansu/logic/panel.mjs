/**
 * Pure view-model decisions for the Ansu GM panel.
 *
 * The panel itself is a thin builder over Foundry documents, so anything it has
 * to DECIDE lives here instead: what the Release DC box should show, and which
 * state dot a roster row earns. Both were wrong in ways no test could catch
 * while the answer lived inline in an ApplicationV2 subclass. No Foundry
 * imports.
 */

import { communionMode } from "./reconcile.mjs";
import {
  clampLoyalty,
  clampWrath,
  loyaltyBand,
  wrathBand,
  callAdjust,
  gateMax,
  lockoutActive,
  durationRoundsFor,
  clampLevel,
  LOYALTY_MAX,
  WRATH_MAX,
  MAX_LEVEL,
} from "./model.mjs";

/**
 * What the Release DC input renders.
 *
 * The typed draft wins, but an EMPTY box is not a draft: `draft ?? suggested`
 * let "" through, so clearing the field blanked the DC for every bearer and
 * every render afterwards until a number was typed and the trigger pressed.
 * (0.6.6)
 */
export function dcDraftValue({ draft, suggested } = {}) {
  if (draft === null || draft === undefined) return suggested;
  return String(draft).trim() === "" ? suggested : draft;
}

/**
 * The state dots a roster row shows, derived rather than read raw.
 *
 * The panel computed `communing` straight off `state.communion.mode` and then
 * rendered it nowhere, so two bearers mid-fight looked identical to a dormant
 * one. The raw read also mislabels a subjugated master, whose derived mode is
 * "permanent", and Lingering deserves its own mark: the boons are live and a
 * save is due at the end of every turn. (0.6.6)
 *
 * @returns {{active: boolean, lingering: boolean, seized: boolean}}
 */
export function rosterDots(state) {
  const mode = communionMode(state ?? {});
  return {
    active: mode === "active",
    lingering: mode === "lingering",
    // "taken" is the Ansu holding the body for good; the dot means the same thing.
    seized: mode === "seized" || mode === "taken",
  };
}

/* ------------------------------------------------------------------ */
/* Rework 0.8 (step E): loyalty and wrath bars, deeds, lockout.         */
/* ------------------------------------------------------------------ */

/** A signed number as text: "+2", "-1", "+0". */
export function signed(n) {
  const v = Math.trunc(Number(n) || 0);
  return v < 0 ? `${v}` : `+${v}`;
}

/**
 * The Loyalty bar: value 0..10, band, the Call DC adjustment, and one segment
 * per point (segment `band` colours the scale: 0 hostile, 1-3 cold, 4-6 wary,
 * 7-10 trust).
 */
export function loyaltyView(loyalty) {
  const value = clampLoyalty(loyalty);
  return {
    value,
    max: LOYALTY_MAX,
    band: loyaltyBand(value),
    adjust: callAdjust(value),
    adjustText: signed(callAdjust(value)),
    segments: Array.from({ length: LOYALTY_MAX }, (_, i) => ({
      value: i + 1,
      filled: i < value,
      band: loyaltyBand(i + 1),
    })),
  };
}

/** The Wrath bar: value 0..6, band, and the conflict DC bump (+2 from 3 on). */
export function wrathView(wrath) {
  const value = clampWrath(wrath);
  const bump = value >= 3 ? 2 : 0;
  return {
    value,
    max: WRATH_MAX,
    band: wrathBand(value),
    bump,
    bumpText: signed(bump),
    segments: Array.from({ length: WRATH_MAX }, (_, i) => ({
      value: i + 1,
      filled: i < value,
      band: wrathBand(i + 1),
    })),
  };
}

/**
 * What a deed does, as data the caller words: loyalty change, and the wrath
 * change or the value wrath is set to. `key` groups deeds with the same effect.
 */
export function deedEffect(deed) {
  const loyalty = Math.trunc(Number(deed?.loyalty) || 0);
  const wrathSet = Number.isFinite(deed?.wrathSet) ? deed.wrathSet : null;
  const wrath = wrathSet === null ? Math.trunc(Number(deed?.wrath) || 0) : null;
  return { loyalty, wrath, wrathSet, key: `${loyalty}|${wrathSet === null ? `d${wrath}` : `s${wrathSet}`}` };
}

/** Deeds the values page leaves out: the Ansu's own outlets and the rest, not things the bearer does. */
export const VALUES_HIDDEN = Object.freeze(["night", "vented-1", "vented-2", "berserk-end"]);

/**
 * The "What the Ansu values" table: deeds grouped by effect, best first
 * (loyalty high to low, then wrath low to high). `tone` is "good" for a loyalty
 * gain, "bad" for a loss of 2 or more or a wrath rise of 2 or more, else "warn".
 */
export function valuesRows(deeds = []) {
  const groups = new Map();
  for (const d of deeds) {
    if (!d?.id || VALUES_HIDDEN.includes(d.id)) continue;
    const eff = deedEffect(d);
    if (!groups.has(eff.key)) groups.set(eff.key, { ...eff, labels: [] });
    groups.get(eff.key).labels.push(d.label);
  }
  const wrathRank = (g) => (g.wrathSet !== null ? -10 + g.wrathSet : g.wrath);
  return [...groups.values()]
    .sort((a, b) => b.loyalty - a.loyalty || wrathRank(a) - wrathRank(b))
    .map((g) => ({
      ...g,
      tone: g.loyalty > 0 ? "good" : g.loyalty <= -2 || (g.wrath ?? 0) >= 2 ? "bad" : "warn",
    }));
}

/**
 * The last `n` deed log lines, newest first: `{t, deed, label, note, loyalty, wrath}`.
 * `byId` maps deed ids to deeds (for the label); an unknown id keeps its id.
 */
export function deedLogLines(log = [], byId = new Map(), n = 10) {
  return (Array.isArray(log) ? log : [])
    .filter((e) => e?.type === "deed")
    .slice(-n)
    .reverse()
    .map((e) => {
      const d = e.data ?? {};
      const pair = (v) => (Array.isArray(v) && v.length === 2 ? v : null);
      return {
        t: e.t ?? null,
        deed: d.deed ?? "?",
        label: byId.get?.(d.deed)?.label ?? d.deed ?? "?",
        note: e.note ?? "",
        loyalty: pair(d.loyalty),
        wrath: pair(d.wrath),
      };
    });
}

/**
 * The lockout as the panel shows it at world time `now`: null when none runs,
 * `{untilRest: true}` for a rest lockout, else `{untilRest: false, seconds}` left.
 */
export function lockoutView(lockout, now) {
  if (!lockoutActive(lockout, now)) return null;
  if (lockout.untilRest === true) return { untilRest: true, seconds: null };
  return { untilRest: false, seconds: Math.max(0, Math.trunc(Number(lockout.until) - Math.trunc(Number(now) || 0))) };
}

/** Seconds as "45 s", "3 min", "1 h 5 min". */
export function shortTime(seconds) {
  const s = Math.max(0, Math.trunc(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/**
 * The next-level rule for a bearer: the highest attunement the character level
 * allows now (gateMax), and whether loyalty 10 would raise the level today
 * (level 1..8, below the gate). Level 9 waits for the GM's fork; a terminal never rises.
 */
export function nextLevelRule(state, charLevel) {
  const level = clampLevel(state?.level);
  const gate = gateMax(charLevel);
  const terminal = state?.terminal ?? null;
  const atNinth = !terminal && level === MAX_LEVEL - 1;
  const canRise = !terminal && level >= 1 && level < MAX_LEVEL - 1 && level < gate;
  return { level, gate, atNinth, canRise, terminal };
}

/** Communion lengths by Call degree at `level`: {cs, s, f} in rounds (null at 10). */
export function lengthsFor(level) {
  return { cs: durationRoundsFor(level, 3), s: durationRoundsFor(level, 2), f: durationRoundsFor(level, 1) };
}
