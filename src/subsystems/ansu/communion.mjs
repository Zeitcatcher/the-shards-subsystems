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

import { MODULE_ID, ANSU } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned, listAttunedActors } from "./state.mjs";
import { durationRounds } from "./logic/model.mjs";
import { COMMUNION_ENTRY_ID } from "./logic/reconcile.mjs";
import { syncActor } from "./sync.mjs";
import { loadContent } from "./content.mjs";
import { callRelease, suggestedDC } from "./release.mjs";
import { callTheCall, suggestedCallDC } from "./call.mjs";
import { maybeReturnFromSeizure } from "./seizure.mjs";
import { refreshAnsuPanel } from "./apps/ansu-panel.mjs";

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

/**
 * On expiry of the Communion countdown: post the Release save and slip to
 * Lingering — the boons stay on while the bearer wrestles the Ansu back down.
 */
export async function handleExpiry(actor) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "active" || st.terminal) return;
  await slipToLingering(actor);
  if (!st.pendingRelease) {
    await callRelease(actor, suggestedDC(st), game.i18n.localize("SHARDS.Ansu.ExpiryReason"));
  }
}

/** End-of-turn re-save while Lingering (once per turn, only without a pending roll). */
async function handleTurnEnd(actor) {
  const st = readAnsu(actor);
  if (st.communion.mode !== "lingering" || st.terminal) return;
  if (st.pendingRelease) return; // one open roll at a time
  await callRelease(actor, suggestedDC(st), game.i18n.localize("SHARDS.Ansu.LingerReason"));
}

async function sweepCombat(combat, changes) {
  // Whose turn just ended? combat.previous survives the update.
  const prevActor = combat.combatants.get(combat.previous?.combatantId)?.actor ?? null;

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor || !isAttuned(actor)) continue;
    const st = readAnsu(actor);

    // Auto-return from a 1-round crit-fail seizure.
    await maybeReturnFromSeizure(actor, combat);

    // Expired countdown → release save + lingering.
    if (st.communion.mode === "active") {
      const effect = findCommunionEffect(actor);
      if (effect && (effect.isExpired === true || effect.system?.expired === true)) {
        await handleExpiry(actor);
      }
    }
  }

  // Lingering re-save fires when the bearer's own turn ends.
  if (prevActor && isAttuned(prevActor)) await handleTurnEnd(prevActor);
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
    if (st.communion.mode === "none" || st.communion.mode === "seized" || st.pendingRelease) return;
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
    sweepCombat(combat, changes).catch((err) => console.error(`${MODULE_ID} | ansu combat sweep`, err));
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
