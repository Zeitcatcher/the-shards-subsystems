/**
 * Pure rules of the conflict of will (0.8): the roll tags that tie a check to its
 * card, what each degree of each stage does, and the reroll table. No Foundry.
 *
 * Stages: "persuade" (optional Diplomacy or Intimidation), "will" (the Will save
 * at the same DC), "berserk" (the Will check at each bearer turn end while the
 * Ansu runs berserk).
 */

import { takeoverPlan } from "./seizure.mjs";
import { wrathBand } from "./model.mjs";

/** Roll option carried by every conflict check (card click and NPC roll alike). */
export const CONFLICT_OPTION = "shards-ansu-conflict";

/** Prefix of the per-card id option that ties a roll to its pending conflict. */
export const CONFLICT_ID_PREFIX = "shards-ansu-conflict-id:";

/** Severities in the order the dialog lists them. */
export const SEVERITIES = Object.freeze(["minor", "serious", "betrayal"]);

/** The persuasion skills the card offers. */
export const PERSUADE_SKILLS = Object.freeze(["diplomacy", "intimidation"]);

/**
 * Does this roll answer the open conflict card? The same rule as the Call and
 * the release: our option plus an open conflict accepts; the id only decides
 * whether the caller warns.
 */
export function acceptConflictRoll({ options, pendingId } = {}) {
  const opts = Array.isArray(options) ? options : [];
  const tagged = opts.find((o) => typeof o === "string" && o.startsWith(CONFLICT_ID_PREFIX));
  const rolledId = tagged ? tagged.slice(CONFLICT_ID_PREFIX.length) : null;
  const accept = opts.includes(CONFLICT_OPTION) && Boolean(pendingId);
  return { accept, idMatch: accept && rolledId === pendingId, rolledId };
}

/** Which roll type answers a stage: a skill check for persuasion, a save otherwise. */
export function rollTypeFor(stage) {
  return stage === "persuade" ? "skill-check" : "saving-throw";
}

const WIN = new Set(["success", "criticalSuccess"]);
const LOSS = new Set(["failure", "criticalFailure"]);

/**
 * What one degree of one stage does.
 * Returns null for an unknown stage or outcome, otherwise
 * `{deeds, resolved, next, takeover, handBack}`:
 * - `deeds`     auto deed ids to apply, in order;
 * - `resolved`  the conflict is over (no further check from it);
 * - `next`      "will" when a failed persuasion hands over to the Will save;
 * - `takeover`  the plan a lost Will save starts (by the wrath band now);
 * - `handBack`  a berserk check won: the bearer takes the body back.
 */
export function conflictResult({ stage, outcome, wrath = 0 } = {}) {
  if (!WIN.has(outcome) && !LOSS.has(outcome)) return null;
  const base = { deeds: [], resolved: true, next: null, takeover: null, handBack: false };
  if (stage === "persuade") {
    if (WIN.has(outcome)) return { ...base, deeds: ["argument"] };
    return { ...base, resolved: false, next: "will" };
  }
  if (stage === "will") {
    if (outcome === "criticalSuccess") return { ...base, deeds: ["argument"] };
    if (outcome === "success") return { ...base, deeds: ["forced-back"] };
    const takeover = takeoverPlan(wrathBand(wrath));
    return { ...base, takeover, deeds: outcome === "criticalFailure" ? ["conflict-cf"] : [] };
  }
  if (stage === "berserk") {
    if (WIN.has(outcome)) return { ...base, handBack: true };
    return { ...base, resolved: false };
  }
  return null;
}

/**
 * The GM recorded a reroll that changed a conflict outcome. What to do now:
 * - `addDeeds`      deeds the new outcome brings that the first did not;
 * - `startTakeover` a held save turned into a lost one: the plan to start;
 * - `undoTakeover`  a lost save turned into a held one: hand the body back with
 *                   no deed (only while that takeover is still running);
 * - `postWill`      a persuasion turned into a failure: the Will save follows;
 * - `cancelWill`    a failed persuasion turned into a success: drop the Will card;
 * - `handBack`      a berserk check turned into a win;
 * - `handFix`       something already applied cannot be taken back here (a deed
 *                   the new outcome lacks, or a berserk hold that was ended):
 *                   the GM settles it by hand.
 */
export function conflictRerollStep({ stage, prevOutcome, outcome, wrath = 0 } = {}) {
  const none = {
    addDeeds: [],
    startTakeover: null,
    undoTakeover: false,
    postWill: false,
    cancelWill: false,
    handBack: false,
    handFix: false,
  };
  const prev = conflictResult({ stage, outcome: prevOutcome, wrath });
  const next = conflictResult({ stage, outcome, wrath });
  if (!prev || !next || prevOutcome === outcome) return none;
  const addDeeds = next.deeds.filter((d) => !prev.deeds.includes(d));
  const dropped = prev.deeds.some((d) => !next.deeds.includes(d));
  return {
    addDeeds,
    startTakeover: next.takeover && !prev.takeover ? next.takeover : null,
    undoTakeover: Boolean(prev.takeover && !next.takeover),
    postWill: next.next === "will" && prev.next !== "will",
    cancelWill: prev.next === "will" && next.next !== "will",
    handBack: next.handBack && !prev.handBack,
    handFix: dropped || (prev.handBack && !next.handBack),
  };
}
