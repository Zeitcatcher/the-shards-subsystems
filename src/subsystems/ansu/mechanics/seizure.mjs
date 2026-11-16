/**
 * Takeovers: the Ansu takes the body (0.8).
 *
 * Every kind snapshots the subsystem state and composes Communion with the
 * entries up to takeoverCap(level) (reconcile), while the GM plays the bearer.
 * - manual:  the GM's own button; the same button hands the body back whole.
 * - forced:  a lost conflict with a calm or angry Ansu; returns at the bearer's
 *            next turn end (angry: one turn end later), restoring the snapshot,
 *            so a running Communion resumes with the rounds it had left and no
 *            release save is rolled. Then `vented-1` / `vented-2`.
 * - berserk: a lost conflict at breaking point; no auto return. A Will check at
 *            each bearer turn end (conflict.mjs) or falling unconscious ends it,
 *            with no Communion and no release save. Then `berserk-end`.
 * - agreed:  the GM lets the Ansu in (calm, once a day, below level 10); runs
 *            durationRoundsFor(level, 2) bearer turns, then the release card.
 * Out of combat nothing counts turns: the GM hands back with the panel button.
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned } from "../state.mjs";
import { durationRoundsFor, takeoverCap, wrathBand, MAX_LEVEL } from "../logic/model.mjs";
import { freshClockStart } from "../logic/timing.mjs";
import {
  seizureSnapshot,
  seizureKind,
  seizureLanding,
  restoredPendings,
  takeoverTurnEnd,
  returnsOnCombatEnd,
} from "../logic/seizure.mjs";
import { syncActor, encounterOf } from "../sync.mjs";
import { recordDeed, checkLevelUp } from "./deeds.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Non-GM users who own this actor. */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/**
 * A takeover card. `to`: "gm" (GM only), "owners" (owners and GM) or "public".
 * The actor name is player-editable, so escape at the choke point.
 */
async function postCard(actor, key, data = {}, { to = "gm", body = null } = {}) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = to === "public" ? [] : to === "owners" ? [...new Set([...playerOwners(actor), ...gmIds])] : gmIds;
  const extra = body ? `<p>${esc(body)}</p>` : "";
  await ChatMessage.create({
    content: `<div class="ansu-card"><p class="ansu-card-title"><i class="fa-solid fa-hand-back-fist"></i> ${esc(game.i18n.format(key, data))}</p>${extra}</div>`,
    ...(whisper.length ? { whisper } : {}),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Is a seizure currently running? */
export function isSeized(state) {
  return state.communion?.mode === "seized";
}

/** Is it this bearer's own turn in their encounter right now? */
function isBearersTurn(actor) {
  const c = encounterOf(actor)?.combatant;
  return Boolean(c && (c.actor === actor || c.actor?.uuid === actor.uuid));
}

/** Rounds left on a running Communion, or null (no effect or no countdown). */
async function communionRoundsLeft(actor, st) {
  if (st.communion?.mode !== "active") return null;
  const { findCommunionEffect, remainingRounds } = await import("./communion.mjs");
  const effect = findCommunionEffect(actor);
  return effect ? remainingRounds(effect) : null;
}

/** May the GM let the Ansu in now? Calm (wrath 0-2), not used since the last rest, below level 10. */
export function canLetIn(st) {
  return (
    !st.terminal &&
    !isSeized(st) &&
    st.level >= 1 &&
    st.level < MAX_LEVEL &&
    wrathBand(st.wrath) === "calm" &&
    st.consentUsed !== true
  );
}

/**
 * Take the body. `kind` is "manual" (default), "forced", "berserk" or "agreed".
 * `turnsLeft` counts the bearer turn ends a forced or agreed takeover lasts;
 * `deed` is applied when the body comes back; `dc` is the berserk Will DC.
 * No-op at a terminal or while already seized. Returns whether the body was
 * actually taken, so a caller never reports a seizure that did not start.
 */
export async function startSeizure(actor, { kind = "manual", turnsLeft = null, deed = null, dc = null, conflictId = null } = {}) {
  const st = readAnsu(actor);
  if (st.terminal || isSeized(st)) return false;
  const roundsLeft = await communionRoundsLeft(actor, st);

  const patch = {
    communion: { mode: "seized", rounds: null, startAt: null },
    // Both open cards go away with the body; the snapshot keeps them and a
    // snapshot landing hands the same ids back, still clickable. (0.6.6)
    pendingRelease: null,
    pendingCall: null,
    seizure: {
      snapshot: seizureSnapshot(st, { roundsLeft }),
      at: Date.now(),
      kind,
      auto: kind === "forced" || kind === "agreed",
      turnsLeft: Number.isInteger(turnsLeft) ? turnsLeft : null,
      // A takeover that starts on the bearer's own turn must survive that
      // turn's end: the Ansu always gets a turn. (B8)
      skipTurnEnd: isBearersTurn(actor),
      deed,
      dc: Number.isFinite(dc) ? dc : null,
      conflictId,
      startRound: encounterOf(actor)?.round ?? null,
    },
  };
  if (kind === "agreed") patch.consentUsed = true;
  await patchAnsu(actor, patch);
  await appendLog(actor, "seizure", { on: true, kind });
  await syncActor(actor);

  const name = actor.name;
  const cap = takeoverCap(st.level);
  if (kind === "forced") {
    await postCard(actor, turnsLeft >= 2 ? "SHARDS.Ansu.TakeoverForcedAngry" : "SHARDS.Ansu.TakeoverForced", { name, cap }, { to: "owners" });
  } else if (kind === "berserk") {
    // The card is public: the Will DC shows only when every player may see DCs.
    const showDc = game.settings.get(MODULE_ID, SETTINGS.ANSU_SHOW_DC) === "all" && Number.isFinite(dc);
    const check = showDc
      ? game.i18n.format("SHARDS.Ansu.TakeoverBerserkCheckDc", { dc })
      : game.i18n.localize("SHARDS.Ansu.TakeoverBerserkCheck");
    await postCard(actor, "SHARDS.Ansu.TakeoverBerserk", { name }, {
      to: "public",
      body: game.i18n.format("SHARDS.Ansu.TakeoverBerserkBody", { name, check, cap }),
    });
  } else if (kind === "agreed") {
    await postCard(actor, "SHARDS.Ansu.TakeoverAgreed", { name, rounds: turnsLeft ?? "?", cap }, { to: "owners" });
  } else {
    await postCard(actor, "SHARDS.Ansu.SeizureStart", { name });
  }
  refreshAnsuPanel();
  return true;
}

/** GM entry point: the bearer lets the Ansu in (an agreed takeover). */
export async function letAnsuIn(actor) {
  const st = readAnsu(actor);
  if (!canLetIn(st)) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.LetInBlocked"));
    return false;
  }
  return startSeizure(actor, { kind: "agreed", turnsLeft: durationRoundsFor(st.level, 2) });
}

/**
 * Give the body back, landing by kind (seizureLanding): manual and forced
 * restore the snapshot; berserk lands dormant; agreed lands dormant and posts
 * the release card. Then the takeover's deed, unless `deed` is false (a reroll
 * undoing the takeover), and the level-up check that was held while seized.
 *
 * One return per bearer at a time: the panel hand-back, the unconscious hook,
 * the turn-end check and the combat-end hook can all fire together, and only
 * the first may apply the deed (review finding 7).
 *
 * `rolledOver` is only passed by the turn-end return, and it decides where a
 * restored Communion's countdown begins. The panel's hand-back leaves it null.
 */
export async function returnFromSeizure(actor, opts = {}) {
  const key = actorKey(actor);
  if (returning.has(key)) return;
  returning.add(key);
  try {
    await returnInner(actor, opts);
  } finally {
    returning.delete(key);
  }
}

const returning = new Set();

async function returnInner(actor, { rolledOver = null, deed = true, via = "gm" } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure?.snapshot) return;

  const snap = st.seizure.snapshot;
  const kind = seizureKind(st.seizure);
  const landing = seizureLanding(st);
  const { pendingRelease, pendingCall } = restoredPendings({ snapshot: snap, landing });
  let communion;
  if (landing === "snapshot") {
    // A restored Communion resumes with the rounds it had left. pf2e resolves a
    // rounds clock at a turn START and a turn-end return fires at a turn end, so
    // the countdown starts where the bearer's next turn can still use it. (0.6.6)
    const resumes = snap.communion?.mode === "active" && rolledOver !== null;
    const startAt = resumes
      ? freshClockStart({ worldTime: game.time?.worldTime, roundTime: CONFIG.time?.roundTime, rolledOver })
      : null;
    communion = { ...snap.communion, startAt };
  } else {
    // An agreed takeover still owes a failed Call's +2 on its release.
    const returnPenalty = landing === "release" && snap.communion?.returnPenalty === 2 ? 2 : 0;
    communion = { mode: "none", rounds: null, startAt: null, returnPenalty };
  }
  await patchAnsu(actor, {
    level: snap.level,
    climb: snap.climb,
    terminal: snap.terminal,
    communion,
    pendingRelease,
    pendingCall,
    // A berserk's Will check card closes with the hold, however it ended. (review finding 8)
    ...(kind === "berserk" ? { pendingConflict: null } : {}),
    seizure: null,
  });
  await appendLog(actor, "seizure", { on: false, kind, via });
  await syncActor(actor);
  await postCard(actor, "SHARDS.Ansu.SeizureEnd", { name: actor.name }, { to: kind === "manual" ? "gm" : "owners" });
  if (deed !== false && st.seizure.deed) await recordDeed(actor, st.seizure.deed);
  // No level-up while seized (review ruling 9): the check runs once, now.
  await checkLevelUp(actor);
  if (landing === "release") {
    const { callRelease, suggestedDC } = await import("./release.mjs");
    await callRelease(actor, suggestedDC(readAnsu(actor)), game.i18n.localize("SHARDS.Ansu.TakeoverAgreedReason"));
  }
  refreshAnsuPanel();
}

/**
 * Turn-end hook (the bearer's own turn ended). Forced and agreed takeovers
 * count down and hand back when due; a berserk one posts its Will check, or
 * ends at once when the bearer is unconscious. Manual never moves.
 */
export async function onSeizureTurnEnd(actor, { rolledOver = null } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure) return;
  const kind = seizureKind(st.seizure);
  if (kind === "berserk" && isUnconscious(actor)) {
    await returnFromSeizure(actor, { via: "unconscious" });
    return;
  }
  const step = takeoverTurnEnd({ kind, turnsLeft: st.seizure.turnsLeft, skipTurnEnd: st.seizure.skipTurnEnd === true });
  if (step.due) {
    await returnFromSeizure(actor, { rolledOver, via: "turn-end" });
    return;
  }
  await patchAnsu(actor, { seizure: { turnsLeft: step.turnsLeft, skipTurnEnd: step.skipTurnEnd } });
  if (step.check) {
    const { postBerserkCheck } = await import("./conflict.mjs");
    await postBerserkCheck(actor);
  }
  refreshAnsuPanel();
}

/** A combat ended: forced and agreed takeovers hand back (no turns will count them). */
export async function onSeizureCombatEnd(actor) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !returnsOnCombatEnd(seizureKind(st.seizure))) return;
  await returnFromSeizure(actor, { via: "combat-end" });
}

/** A berserk takeover ends when the bearer falls unconscious. */
export async function onBearerUnconscious(actor) {
  const st = readAnsu(actor);
  if (!isSeized(st) || seizureKind(st.seizure) !== "berserk") return;
  await returnFromSeizure(actor, { via: "unconscious" });
}

/** pf2e's own condition lookup, defensively. */
function isUnconscious(actor) {
  try {
    if (typeof actor.hasCondition === "function") return Boolean(actor.hasCondition("unconscious"));
  } catch {
    /* fall through */
  }
  return Boolean(actor.itemTypes?.condition?.some?.((c) => c.slug === "unconscious"));
}

/** Register the unconscious watcher. Primary GM only. Call on ready. */
export function registerSeizureHooks() {
  Hooks.on("createItem", (item) => {
    if (!isPrimaryGM()) return;
    if (item?.type !== "condition" || item.slug !== "unconscious") return;
    const actor = item.actor;
    if (!actor || !isAttuned(actor)) return;
    onBearerUnconscious(actor).catch((err) => console.error(`${MODULE_ID} | ansu berserk unconscious`, err));
  });
}
