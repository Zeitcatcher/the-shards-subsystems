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
import { readAnsu, patchAnsu, appendLog, isAttuned } from "./state.mjs";
import { durationRounds } from "./logic/model.mjs";
import { COMMUNION_ENTRY_ID } from "./logic/reconcile.mjs";
import { syncActor } from "./sync.mjs";
import { loadContent } from "./content.mjs";
import { callRelease, suggestedDC } from "./release.mjs";
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

/** Reset per-Communion actives' frequency uses (Roar comes back on each invoke). */
async function resetPerCommunionUses(actor) {
  const content = await loadContent().catch(() => null);
  if (!content) return;
  const updates = [];
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, ANSU);
    if (!tag?.entryId || item.type !== "action") continue;
    // Only actives the content marks per-communion carry a counter the module owns.
    if (!content.byId.get(tag.entryId)?.actionData?.perCommunion) continue;
    const max = item.system?.frequency?.max;
    if (Number.isFinite(max) && item.system?.frequency?.value !== max) {
      updates.push({ _id: item.id, "system.frequency.value": max });
    }
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/**
 * Enter Communion. For a subjugated master this is the free toggle (no saves,
 * unlimited); otherwise the tier's duration applies. No-op while already running.
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
  await resetPerCommunionUses(actor);
  await syncActor(actor);
  refreshAnsuPanel();
}

/**
 * End Communion cleanly (successful release, subjugated free toggle, or the GM's
 * no-save override). Climb movement is the release recorder's business.
 */
export async function endCommunion(actor, { via = "gm" } = {}) {
  const st = readAnsu(actor);
  if (st.communion.mode === "none") return;
  await patchAnsu(actor, { communion: { mode: "none", rounds: null } });
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
async function handleExpiry(actor) {
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
    await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.InvokedByPlayer"));
  } else if (tag.entryId === "release-the-ansu") {
    const st = readAnsu(actor);
    if (st.terminal === "subjugated") {
      await endCommunion(actor, { via: "mastery" });
      return;
    }
    if (st.communion.mode === "none" || st.pendingRelease) return;
    await callRelease(actor, suggestedDC(st), game.i18n.localize("SHARDS.Ansu.ReleaseByPlayer"));
  }
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
}
