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
import { isPrimaryGM } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned, listAttunedActors } from "../state.mjs";
import { durationRounds } from "../logic/model.mjs";
import { sweepHandlesExpiry, turnEndReleaseDue } from "../logic/timing.mjs";
import { COMMUNION_ENTRY_ID } from "../logic/reconcile.mjs";
import { syncActor } from "../sync.mjs";
import { loadContent } from "../content.mjs";
import { callRelease, suggestedDC } from "./release.mjs";
import { callTheCall, suggestedCallDC } from "./call.mjs";
import { maybeReturnFromSeizure } from "./seizure.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

/** The live Communion effect item on an actor, if any. */
export function findCommunionEffect(actor) {
  return actor.items.find((i) => i.getFlag?.(MODULE_ID, ANSU)?.entryId === COMMUNION_ENTRY_ID);
}

/** Remaining rounds on the Communion effect (native duration, defensively read). */
export function remainingRounds(effect) {
  try {
    const seconds = effect.remainingDuration?.remaining;
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds / 6));
  } catch {
    /* fall through to the raw duration */
  }
  const v = Number(effect.system?.duration?.value);
  return Number.isFinite(v) && v > 0 ? v : 0;
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
  await patchAnsu(actor, { communion: { mode: "active", rounds } });
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
 */
export async function endCommunion(actor, { via = "gm" } = {}) {
  const st = readAnsu(actor);
  if (st.communion.mode === "none") return;
  // Ending Communion clears any open release roll and any seizure blob, so a stale
  // pendingRelease can't wedge the next communion's automation and a seizure can't
  // be stranded with the panel Return button dead. (B6, B7)
  await patchAnsu(actor, { communion: { mode: "none", rounds: null }, pendingRelease: null, seizure: null });
  await appendLog(actor, "communion", { on: false, via });
  await syncActor(actor);
  refreshAnsuPanel();
}

/** Slip from active into Lingering (failed release / expired duration unresolved). */
export async function slipToLingering(actor) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "active" && st.communion.mode !== "seized") return;
  await patchAnsu(actor, { communion: { mode: "lingering", rounds: null } });
  await appendLog(actor, "lingering", {});
  await syncActor(actor);
  refreshAnsuPanel();
}

/* ------------------------------------------------------------------ */
/* Combat watchers                                                      */
/* ------------------------------------------------------------------ */

// One expiry chain per actor. Our combat sweep and pf2e's deletion of the expired
// effect can both reach handleExpiry on the same turn change; whichever arrives
// first owns it, and the other must not post a second Release card. (0.6.5)
const expiring = new Set();

/**
 * On expiry of the Communion countdown: post the Release save and slip to
 * Lingering — the boons stay on while the bearer wrestles the Ansu back down.
 */
export async function handleExpiry(actor) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "active" || st.terminal) return;
  if (expiring.has(actor.id)) return;
  expiring.add(actor.id);
  try {
    await slipToLingering(actor);
    // Re-read before deciding: the state was just written, and a player's own
    // Release click could have landed a pending marker while we awaited.
    const now = readAnsu(actor);
    if (!now.pendingRelease) {
      await callRelease(actor, suggestedDC(now), game.i18n.localize("SHARDS.Ansu.ExpiryReason"));
    }
  } finally {
    expiring.delete(actor.id);
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
const seenExpired = new Set();

async function sweepCombat(combat) {
  const removeEffects = game.pf2e?.settings?.automation?.removeEffects;

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || !isAttuned(actor)) continue;

    // Expired countdown → release save + lingering.
    const st = readAnsu(actor);
    const effect = st.communion.mode === "active" ? findCommunionEffect(actor) : null;
    const expired = Boolean(effect) && (effect.isExpired === true || effect.system?.expired === true);
    if (!expired) {
      seenExpired.delete(actor.id);
      continue;
    }
    if (sweepHandlesExpiry(removeEffects, seenExpired.has(actor.id))) {
      seenExpired.delete(actor.id);
      await handleExpiry(actor);
    } else {
      seenExpired.add(actor.id);
    }
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

async function whisperGMCard(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${text}</p></div>`,
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
    (async () => {
      await maybeReturnFromSeizure(actor, encounter); // 1-round crit-fail seizure
      await handleTurnEnd(actor); // lingering re-save
    })().catch((err) => console.error(`${MODULE_ID} | ansu turn end`, err));
  });

  // Cooldowns run on world time (combat rounds advance it; so does the GM's clock).
  Hooks.on("updateWorldTime", () => {
    if (!isPrimaryGM()) return;
    sweepCooldowns().catch((err) => console.error(`${MODULE_ID} | ansu cooldown sweep`, err));
  });

  // A combat ending mid-Communion leaves the effect unlimited; nothing to do.
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
  });

  // Sweep once on load: a cooldown that lapsed while the world was closed should
  // re-enable its Use button without waiting for the next world-time tick. (F)
  if (isPrimaryGM()) {
    sweepCooldowns().catch((err) => console.error(`${MODULE_ID} | ansu cooldown ready-sweep`, err));
  }
}
