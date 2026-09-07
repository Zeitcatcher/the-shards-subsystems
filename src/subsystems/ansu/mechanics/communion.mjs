/**
 * The Communion state machine. Invoke applies the composed Communion effect for
 * the tier's duration (rounds tick natively in combat); when it expires the
 * module posts the Release save automatically and the state slips to Lingering —
 * boons stay on while the bearer wrestles, re-saving at the end of each of their
 * turns. Out of combat nothing expires: the GM drives from the panel.
 *
 * Player side: clicking the "Invoke the Ansu" / "Release the Ansu" sheet actions
 * posts a chat card; a createChatMessage capture turns those cards into state.
 */

import { MODULE_ID, ANSU } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned, listAttunedActors } from "../state.mjs";
import { durationRounds } from "../logic/model.mjs";
import {
  sweepHandlesExpiry,
  turnEndReleaseDue,
  endedRoundOf,
  roundRolledOver,
  communionLooksExpired,
  roundsLeftFrom,
} from "../logic/timing.mjs";
import { COMMUNION_ENTRY_ID } from "../logic/reconcile.mjs";
import { syncActor, encounterOf } from "../sync.mjs";
import { loadContent } from "../content.mjs";
import { callRelease, suggestedDC } from "./release.mjs";
import { callTheCall, suggestedCallDC } from "./call.mjs";
import { maybeReturnFromSeizure } from "./seizure.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

/** The live Communion effect item on an actor, if any. */
export function findCommunionEffect(actor) {
  return actor.items.find((i) => i.getFlag?.(MODULE_ID, ANSU)?.entryId === COMMUNION_ENTRY_ID);
}

/**
 * Rounds left on the Communion effect (native duration, defensively read), or
 * null when the effect carries no countdown at all. The old signature returned 0
 * for both an unlimited effect and the final round, and the panel's `{{#if}}`
 * hid the row in both cases. (0.6.6)
 */
export function remainingRounds(effect) {
  let remaining;
  try {
    remaining = effect.remainingDuration?.remaining;
  } catch {
    /* pf2e computes this against world time; a bad read just means no signal */
  }
  return roundsLeftFrom({
    remaining,
    value: effect.system?.duration?.value,
    unit: effect.system?.duration?.unit,
    roundTime: globalThis.CONFIG?.time?.roundTime,
  });
}

/* ------------------------------------------------------------------ */
/* Entering and leaving the state                                       */
/* ------------------------------------------------------------------ */

/**
 * Enter Communion directly (post-Call, subjugated free toggle, or GM force).
 * Per-communion counters need no reset: the actives are created fresh on invoke.
 */
export async function invokeCommunion(actor, note = "") {
  const st = readAnsu(actor);
  if (st.terminal === "taken") return;
  if (st.communion.mode !== "none") {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.AlreadyActive"));
    return;
  }
  if (!st.terminal && st.level < 1) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoAttunement"));
    return;
  }
  const rounds = st.terminal === "subjugated" ? null : durationRounds(st.level);
  // startAt is the seizure return's one-shot clock compensation; a fresh Invoke
  // starts its countdown at the sync, so clear any leftover stamp. (0.6.6)
  await patchAnsu(actor, { communion: { mode: "active", rounds, startAt: null } });
  await appendLog(actor, "communion", { on: true, rounds }, note);
  await syncActor(actor);
  refreshAnsuPanel();
}

/**
 * The player-facing entrance: subjugated masters toggle straight in; everyone
 * else must win the Call first (Intimidation vs 20 + 2×attunement, uncapped).
 * The Call capture then drives invokeCommunion / the crit-fail seizure.
 */
export async function requestInvoke(actor) {
  const st = readAnsu(actor);
  if (st.terminal === "taken") return;
  if (st.communion.mode !== "none") {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.AlreadyActive"));
    return;
  }
  if (!st.terminal && st.level < 1) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoAttunement"));
    return;
  }
  if (st.terminal === "subjugated") {
    await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.InvokedByPlayer"));
    return;
  }
  // A stale pending Call (unrolled card from an earlier scene) is replaced, not
  // a lock — callTheCall posts a fresh card with a fresh id.
  await callTheCall(actor, suggestedCallDC(st));
}

/**
 * End Communion cleanly (successful release, subjugated free toggle, or the GM's
 * no-save override). Climb movement is the release recorder's business.
 *
 * `note` rides along to the history row this writes. Without it the panel's
 * "End (no save)" had to append a SECOND row to carry its override note, and
 * `describeEntry` ignores `via`, so the History dialog and the journal export
 * both showed "Communion ended" twice at the same timestamp. (0.6.6)
 */
export async function endCommunion(actor, { via = "gm", note = "" } = {}) {
  const st = readAnsu(actor);
  if (st.communion.mode === "none") return;
  // Ending Communion clears any open release roll and any seizure blob, so a stale
  // pendingRelease can't wedge the next communion's automation and a seizure can't
  // be stranded with the panel Return button dead. (B6, B7)
  await patchAnsu(actor, {
    communion: { mode: "none", rounds: null, startAt: null },
    pendingRelease: null,
    seizure: null,
  });
  await appendLog(actor, "communion", { on: false, via }, note);
  await syncActor(actor);
  refreshAnsuPanel();
}

/**
 * Slip from active into Lingering (failed release / expired duration unresolved).
 * `runOpts` is the expiry rebuild, passed straight to the sync that re-creates
 * the effect pf2e just deleted.
 */
export async function slipToLingering(actor, runOpts = {}) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "active" && st.communion.mode !== "seized") return;
  await patchAnsu(actor, { communion: { mode: "lingering", rounds: null, startAt: null } });
  await appendLog(actor, "lingering", {});
  await syncActor(actor, runOpts);
  refreshAnsuPanel();
}

/* ------------------------------------------------------------------ */
/* Combat watchers                                                      */
/* ------------------------------------------------------------------ */

// One expiry chain per actor. Our combat sweep and pf2e's deletion of the expired
// effect can both reach handleExpiry on the same turn change; whichever arrives
// first owns it, and the other must not post a second Release card. (0.6.5)
// Keyed by uuid: two unlinked tokens of one statblock share actor.id, and this
// guard is held across three awaits — one token's expiry ate the other's. (0.6.6)
const expiring = new Set();

/**
 * On expiry of the Communion countdown: post the Release save and slip to
 * Lingering — the boons stay on while the bearer wrestles the Ansu back down.
 *
 * `runOpts` arrives only from the deleteItem path, where pf2e removed the
 * expired effect: the Lingering sync below RE-creates it, so it must be told not
 * to re-fire the create-time grants and given back the temp HP pool the delete
 * zeroed. The sweep path (removeEffects off) is an in-place update and needs
 * neither. (0.6.6)
 */
export async function handleExpiry(actor, runOpts = {}) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "active" || st.terminal) return;
  const key = actorKey(actor);
  if (expiring.has(key)) return;
  expiring.add(key);
  try {
    await slipToLingering(actor, runOpts);
    // Re-read before deciding: the state was just written, and a player's own
    // Release click could have landed a pending marker while we awaited.
    const now = readAnsu(actor);
    if (!now.pendingRelease) {
      await callRelease(actor, suggestedDC(now), game.i18n.localize("SHARDS.Ansu.ExpiryReason"));
    }
  } finally {
    expiring.delete(key);
  }
}

/**
 * End-of-turn re-save while Lingering. A fresh card goes up every turn:
 * callRelease replaces the stale pending marker, so a card nobody rolled (or a
 * duplicate from an earlier race) can never wedge the wrestle shut. (0.6.5)
 */
async function handleTurnEnd(actor) {
  const st = readAnsu(actor);
  if (!turnEndReleaseDue({ mode: st.communion.mode, terminal: st.terminal })) return;
  await callRelease(actor, suggestedDC(st), game.i18n.localize("SHARDS.Ansu.LingerReason"));
}

// Actors whose Communion effect a previous sweep already found expired. pf2e's
// effect tracker normally deletes it right after this hook, and that delete is
// what resolves the expiry; the sweep only steps in when pf2e demonstrably
// didn't (auto-removal off, or the item still sitting there a sweep later).
// Keyed by uuid — on actor.id a non-expired sibling token wiped its twin's
// grace mark on every sweep, no race needed. (0.6.6)
const seenExpired = new Set();

/** Every readable expiry signal on a live Communion effect, defensively. */
function looksExpired(effect) {
  let remainingExpired;
  try {
    remainingExpired = effect.remainingDuration?.expired;
  } catch {
    /* pf2e computes this against world time; a bad read is simply no signal */
  }
  return communionLooksExpired({
    remainingExpired,
    isExpired: effect.isExpired,
    systemExpired: effect.system?.expired,
  });
}

/**
 * Resolve one bearer's expired countdown, honouring the grace rule: with pf2e's
 * auto-removal on, its delete of the expired item is what carries the expiry, so
 * we stand down for exactly one pass and only step in when it demonstrably did
 * not. Shared by the combat sweep and the world-time sweep.
 */
async function resolveExpiry(actor, removeEffects) {
  const st = readAnsu(actor);
  const effect = st.communion.mode === "active" && !st.terminal ? findCommunionEffect(actor) : null;
  const key = actorKey(actor);
  if (!effect || !looksExpired(effect)) {
    seenExpired.delete(key);
    return;
  }
  if (sweepHandlesExpiry(removeEffects, seenExpired.has(key))) {
    seenExpired.delete(key);
    await handleExpiry(actor);
  } else {
    seenExpired.add(key);
  }
}

async function sweepCombat(combat) {
  const removeEffects = game.pf2e?.settings?.automation?.removeEffects;
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || !isAttuned(actor)) continue;
    await resolveExpiry(actor, removeEffects);
  }
}

/**
 * The same expiry check for bearers no encounter is watching.
 *
 * A turn change was the only thing that ever resolved an expiry: the combat
 * sweep, or pf2e deleting the expired item. With `automation.removeEffects` off
 * (a configuration `sweepHandlesExpiry` exists to support) the second path does
 * not exist, so a fight that ended mid-Communion left the state "active" forever
 * with every rule element ignored and no Release ever posted. World time moves
 * on its own (the GM's clock, a rest) and the rounds countdown keeps running
 * against it, so this is where that expiry lands. (0.6.6)
 *
 * Bearers still IN a started encounter are skipped deliberately: a round advance
 * fires both hooks, and handling them here as well would spend the one sweep of
 * grace `sweepHandlesExpiry` gives pf2e's own removal to act first.
 */
async function sweepExpiryOutsideCombat() {
  const removeEffects = game.pf2e?.settings?.automation?.removeEffects;
  for (const actor of listAttunedActors()) {
    if (encounterOf(actor)) continue;
    await resolveExpiry(actor, removeEffects);
  }
}

/* ------------------------------------------------------------------ */
/* Player-side action capture                                           */
/* ------------------------------------------------------------------ */

function actorFromMessage(message) {
  const uuid = message.flags?.pf2e?.origin?.uuid;
  if (typeof uuid === "string") {
    const doc = fromUuidSync(uuid);
    const item = doc?.documentName === "Item" ? doc : null;
    if (item?.actor) return { actor: item.actor, item };
  }
  const sid = message.speaker?.actor;
  const actor = sid ? game.actors.get(sid) : null;
  return { actor, item: null };
}

/** Clicking the Invoke / Release sheet actions drives the state machine. */
async function handleActionCard(message) {
  const { actor, item } = actorFromMessage(message);
  if (!actor || !item || !isAttuned(actor)) return;
  const tag = item.getFlag?.(MODULE_ID, ANSU);
  if (!tag?.entryId) return;

  if (tag.entryId === "invoke-the-ansu") {
    await requestInvoke(actor);
  } else if (tag.entryId === "release-the-ansu") {
    const st = readAnsu(actor);
    if (st.terminal === "subjugated") {
      await endCommunion(actor, { via: "mastery" });
      return;
    }
    // No Release while the Ansu holds the body: a seizure must be returned (GM
    // button), not dismissed by a save that would strand the snapshot. (B6)
    // A pending Release does NOT block: callRelease replaces the stale card,
    // so a missed roll is recoverable by clicking Release again.
    if (st.communion.mode === "none" || st.communion.mode === "seized") return;
    await callRelease(actor, suggestedDC(st), game.i18n.localize("SHARDS.Ansu.ReleaseByPlayer"));
  } else {
    await maybeStartCooldown(actor, tag.entryId);
  }
}

/**
 * Cooldown actives (The Ansu Refuses): using the card starts the module-owned
 * world-time cooldown, auto-applies wounded +1, and whispers the GM. Staying at
 * 1 HP stays manual — the GM sets HP.
 */
async function maybeStartCooldown(actor, entryId) {
  const content = await loadContent().catch(() => null);
  const entry = content?.byId?.get(entryId);
  const minutes = entry?.actionData?.cooldownMinutes;
  if (!Number.isInteger(minutes)) return;

  const st = readAnsu(actor);
  const now = game.time?.worldTime ?? 0;
  const runningUntil = Number((st.cooldowns ?? []).find((c) => c?.id === entryId)?.until) || 0;
  if (now < runningUntil) {
    const left = Math.ceil((runningUntil - now) / 60);
    await whisperGMCard(actor, game.i18n.format("SHARDS.Ansu.CooldownRunning", { name: entry.name, minutes: left }));
    return;
  }

  const cooldowns = [
    ...(st.cooldowns ?? []).filter((c) => c?.id !== entryId),
    { id: entryId, until: now + minutes * 60 },
  ];
  await patchAnsu(actor, { cooldowns });
  await appendLog(actor, "refuses", { entryId, minutes });
  if (entryId === "the-ansu-refuses") {
    try {
      await actor.increaseCondition?.("wounded");
    } catch (err) {
      console.warn(`${MODULE_ID} | could not auto-apply wounded`, err);
    }
    await whisperGMCard(actor, game.i18n.format("SHARDS.Ansu.RefusesUsed", { name: actor.name }));
  }
  await syncActor(actor); // bakes frequency 0 → the Use button greys out
  refreshAnsuPanel();
}

/** GM-only card. Escaped here, at the choke point: no lang value carries markup. */
async function whisperGMCard(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${foundry.utils.escapeHTML(String(text ?? ""))}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Prune expired cooldowns and re-enable their Use buttons as world time moves. */
async function sweepCooldowns() {
  const now = game.time?.worldTime ?? 0;
  for (const actor of listAttunedActors()) {
    const st = readAnsu(actor);
    const all = st.cooldowns ?? [];
    if (!all.length) continue;
    const kept = all.filter((c) => now < Number(c?.until));
    if (kept.length === all.length) continue;
    await patchAnsu(actor, { cooldowns: kept });
    await syncActor(actor);
  }
  refreshAnsuPanel();
}

/**
 * A bearer joining a started encounter with Communion already running: resync so
 * the untimed effect picks up its rounds countdown. Fire-and-forget; syncActor
 * is a no-op when there is nothing to change.
 */
function startCommunionClock(actor) {
  if (!actor || !isAttuned(actor)) return;
  if (readAnsu(actor).communion.mode !== "active") return;
  syncActor(actor).catch((err) => console.error(`${MODULE_ID} | ansu communion clock on combat start`, err));
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

export function registerCommunionHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    handleActionCard(message).catch((err) => console.error(`${MODULE_ID} | ansu action card`, err));
  });

  Hooks.on("updateCombat", (combat, changes) => {
    if (!isPrimaryGM()) return;
    if (changes?.round === undefined && changes?.turn === undefined) return;
    sweepCombat(combat).catch((err) => console.error(`${MODULE_ID} | ansu combat sweep`, err));
  });

  // Turn ends come from pf2e's own signal rather than combat.previous: it fires
  // on the active GM client after pf2e finished its turn-end processing, and it
  // names the combatant whose turn ended, so there is nothing to infer. (0.6.5)
  Hooks.on("pf2e.endTurn", (combatant, encounter) => {
    if (!isPrimaryGM()) return;
    const actor = combatant?.actor;
    if (!actor || !isAttuned(actor)) return;
    // Resolve the round the ended turn BELONGED to. The combat update lands
    // before this hook, so when the last combatant in the order finishes,
    // encounter.round already shows the next one — and passing that down handed
    // a seized body back at the end of the very turn the seizure began on. (0.6.6)
    const endedRound = endedRoundOf({ combatant, encounter });
    const rolledOver = roundRolledOver({ endedRound, currentRound: encounter?.round });
    (async () => {
      // 1-round crit-fail seizure; rolledOver also anchors the returned clock
      await maybeReturnFromSeizure(actor, encounter, { round: endedRound, rolledOver });
      await handleTurnEnd(actor); // lingering re-save
    })().catch((err) => console.error(`${MODULE_ID} | ansu turn end`, err));
  });

  // A Communion invoked out of combat is written with no duration at all. When the
  // fight starts — or the bearer is dropped into one already running — the tier
  // countdown has to be installed: the composed content is identical either way,
  // so only syncActor's own duration-drift check can see it. (0.6.6)
  Hooks.on("combatStart", (combat) => {
    if (!isPrimaryGM()) return;
    for (const combatant of combat.combatants) startCommunionClock(combatant.actor);
  });

  Hooks.on("createCombatant", (combatant) => {
    if (!isPrimaryGM()) return;
    startCommunionClock(combatant?.actor);
  });

  // Cooldowns run on world time (combat rounds advance it; so does the GM's clock),
  // and so does the Communion countdown once no turn change is coming.
  Hooks.on("updateWorldTime", () => {
    if (!isPrimaryGM()) return;
    sweepCooldowns().catch((err) => console.error(`${MODULE_ID} | ansu cooldown sweep`, err));
    sweepExpiryOutsideCombat().catch((err) => console.error(`${MODULE_ID} | ansu world-time expiry sweep`, err));
  });

  // A combat ending mid-Communion does NOT rewrite the effect: it keeps its rounds
  // duration and goes on running against world time, so it expires later through
  // pf2e's delete or the world-time sweep above. Check once here too, since the
  // countdown may already have run out during the last turn.
  // A deleted combat with a live 1-round seizure must still return the body.
  Hooks.on("deleteCombat", (combat) => {
    if (!isPrimaryGM()) return;
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor || !isAttuned(actor)) continue;
      maybeReturnFromSeizure(actor, null, { force: true }).catch((err) =>
        console.error(`${MODULE_ID} | ansu seizure return on combat end`, err),
      );
    }
    sweepExpiryOutsideCombat().catch((err) =>
      console.error(`${MODULE_ID} | ansu expiry sweep on combat end`, err),
    );
  });

  // Sweep once on load: a cooldown that lapsed while the world was closed should
  // re-enable its Use button without waiting for the next world-time tick. (F)
  if (isPrimaryGM()) {
    sweepCooldowns().catch((err) => console.error(`${MODULE_ID} | ansu cooldown ready-sweep`, err));
  }
}
