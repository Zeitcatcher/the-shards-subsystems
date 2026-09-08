/**
 * Dragon-style recharge, built on native pf2e mechanics.
 *
 * The Use button comes from the ability's selfEffect (native). Using the ability in
 * combat posts pf2e's self-effect message; this module rolls the recharge die and
 * applies the "Recharge: <name>" effect with the rolled duration. From there the
 * countdown, the remaining-rounds display, and the expiry are all native effect
 * behavior. A normalizer keeps manually-applied copies consistent (deduped, deleted
 * out of combat, rolled if unrolled), and a round sweep clears expired markers when
 * the world doesn't auto-remove them. No frequency, no counters, no use-state.
 */

import { MODULE_ID, IZIR } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { loadContent } from "../content.mjs";
import { isMarked } from "../state.mjs";

const RECHARGE_IMG = "icons/magic/time/hourglass-tilted-glowing-gold.webp";

/**
 * Is this actor in a started encounter — any of them?
 *
 * `game.combat` is the encounter on the GM's VIEWED scene, so a party fighting on
 * one map while the GM had another open read as out of combat: the Use button
 * rolled no cooldown at all. Ask the encounters themselves instead. (F4)
 */
export function inActiveCombat(actor) {
  return Boolean(encounterOf(actor));
}

/** The started encounter this actor is fighting in, or null. */
export function encounterOf(actor) {
  if (!actor) return null;
  const combats = game.combats?.contents ?? game.combats ?? [];
  return (
    [...combats].find(
      (c) => c?.started && (c.combatants ?? []).some((x) => x.actor === actor || x.actor?.uuid === actor.uuid),
    ) ?? null
  );
}

/** The recharge marker for an entry, if any — expired copies included. */
export function findRechargeEffect(actor, entryId) {
  return actor.items.find((i) => i.type === "effect" && i.getFlag?.(MODULE_ID, "izirRecharge") === entryId);
}

/** Is a marker still counting down? An expired one blocks nothing. (F4) */
export function isRunning(effect) {
  return Boolean(effect) && effect.isExpired !== true && effect.system?.expired !== true;
}

/** Remaining rounds on a recharge effect (native duration, defensively read). */
export function remainingRounds(effect) {
  try {
    const seconds = effect.remainingDuration?.remaining;
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds / 6));
  } catch {
    /* fall through to the raw duration */
  }
  return Math.max(0, Number(effect.system?.duration?.value) || 0);
}

async function whisperStillRecharging(actor, name, rounds) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create(
    {
      content: `<div class="izir-temptation-card"><p>${game.i18n.format("SHARDS.Izir.StillRecharging", { name, rounds })}</p></div>`,
      whisper: gmIds,
      speaker: ChatMessage.getSpeaker({ actor }),
    },
    { chatBubble: false }, // not speech (F36)
  );
}

/** Roll the recharge die (publicly, with dice animation) and return the rounds. */
async function rollRecharge(actor, name, formula) {
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: game.i18n.format("SHARDS.Izir.RechargeFlavor", { name }),
  });
  return Math.max(1, roll.total);
}

/** Create the rolled recharge marker directly (the auto path after a Use). */
async function createRechargeEffect(actor, entry, name, rounds) {
  await actor.createEmbeddedDocuments("Item", [
    {
      name: game.i18n.format("SHARDS.Izir.RechargeEffect", { name }),
      type: "effect",
      img: RECHARGE_IMG,
      system: {
        description: {
          value: `<p>${game.i18n.format("SHARDS.Izir.RechargeDesc", { name, rounds })}</p>`,
        },
        slug: `shards-izir-recharge-${entry.id}`,
        duration: { value: rounds, unit: "rounds", sustained: false, expiry: "turn-start" },
        unidentified: false,
        level: { value: 1 },
        tokenIcon: { show: true },
        badge: null,
        traits: { value: [], rarity: "common" },
        rules: [],
        start: { value: 0, initiative: null },
        publication: { title: "The Shards", authors: "Zeitcatcher", license: "ORC", remaster: true },
      },
      flags: { [MODULE_ID]: { izirRecharge: entry.id, izirRolled: true } },
    },
  ]);
}

/* ------------------------------------------------------------------ */
/* Hook 1: the Use message (pf2e flags it context.type = "self-effect") */
/* ------------------------------------------------------------------ */

// In-flight guard: one recharge roll per ability per Use burst.
const rolling = new Set();

async function handleUseMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (ctx?.type !== "self-effect" || !ctx.item) return;
  const actor = message.actor ?? game.actors.get(message.speaker?.actor);
  if (!actor) return;
  const item = actor.items.get(ctx.item);
  if (!item) return;

  const tag = item.getFlag?.(MODULE_ID, IZIR);
  if (!tag?.entryId) return;
  const content = await loadContent().catch(() => null);
  const entry = content?.byId?.get(tag.entryId);
  if (!entry?.actionData?.recharge) return;

  if (!inActiveCombat(actor)) return; // no cooldowns outside combat

  // A double-click posts two self-effect messages that would both pass the gate
  // and roll twice; the synchronous check-and-add lets only the first win. (F)
  const gateKey = `${actorKey(actor)}:${entry.id}`;
  if (rolling.has(gateKey)) return;
  rolling.add(gateKey);
  try {
    const running = findRechargeEffect(actor, entry.id);
    if (running) {
      // An already-expired marker must not block reuse — the world's "remove
      // expired effects" automation may be off, or a sweep hasn't run yet. Clear
      // the stale marker and roll a fresh cooldown. (F)
      if (running.isExpired === true || running.system?.expired === true) {
        await running.delete().catch(() => {});
      } else {
        await whisperStillRecharging(actor, item.name, remainingRounds(running));
        return;
      }
    }
    const rounds = await rollRecharge(actor, item.name, entry.actionData.recharge);
    await createRechargeEffect(actor, entry, item.name, rounds);
  } finally {
    rolling.delete(gateKey);
  }
}

/* ------------------------------------------------------------------ */
/* Hook 2: normalizer for recharge markers created any other way        */
/* (the card's own "Apply effect" button applies the pack copy)         */
/* ------------------------------------------------------------------ */

async function normalizeMarker(item) {
  const entryId = item.getFlag?.(MODULE_ID, "izirRecharge");
  const actor = item.parent;
  if (!entryId || !actor) return;

  // Out of combat there is no round clock to hang a cooldown on, but a marker
  // dropped on an actor between fights is the GM staging one on purpose. Deleting
  // it undid deliberate prep with no explanation; leave it where it was put. (F16)
  if (!inActiveCombat(actor)) return;

  // The auto path is mid-roll for this ability: this copy is the card's Apply
  // Effect landing inside that window. Drop it before it can trigger a second
  // public recharge die. (F34)
  if (rolling.has(`${actorKey(actor)}:${entryId}`)) {
    await item.delete();
    return;
  }

  // A live marker already exists: this copy is a duplicate. An expired sibling is
  // not in the way and is left for the sweep. (F4)
  const sibling = actor.items.find(
    (i) => i.id !== item.id && i.getFlag?.(MODULE_ID, "izirRecharge") === entryId && isRunning(i),
  );
  if (sibling) {
    // Silently: the cooldown that matters was already announced when it was
    // rolled, and repeating "still recharging" here read as a refused reuse — with
    // the effect's own name ("Recharge: Umbral Grasp") doubled into the line. (F34)
    await item.delete();
    return;
  }

  // Unrolled pack copy (applied via the card button): roll and stamp the duration.
  if (!item.getFlag(MODULE_ID, "izirRolled")) {
    const content = await loadContent().catch(() => null);
    const entry = content?.byId?.get(entryId);
    const formula = entry?.actionData?.recharge ?? "1d6";
    const rounds = await rollRecharge(actor, entry?.name ?? item.name, formula);
    await item.update({
      "system.duration.value": rounds,
      [`flags.${MODULE_ID}.izirRolled`]: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerRechargeHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    handleUseMessage(message).catch((err) => console.error(`${MODULE_ID} | recharge use`, err));
  });

  Hooks.on("createItem", (item) => {
    if (!isPrimaryGM()) return;
    normalizeMarker(item).catch((err) => console.error(`${MODULE_ID} | recharge normalize`, err));
  });

  // Cooldowns are measured in rounds, so they cannot outlive the encounter that
  // gave them meaning. Without this, ending a fight left every marker frozen on
  // the sheet and the ability greyed out until someone deleted it by hand. (F4)
  Hooks.on("deleteCombat", (combat) => {
    if (!isPrimaryGM()) return;
    clearRechargesFor(combat).catch((err) => console.error(`${MODULE_ID} | recharge cleanup`, err));
  });

  // pf2e leaves expired effects in place unless the world auto-removes them;
  // sweep our markers on round/turn changes so abilities come back on time.
  Hooks.on("updateCombat", (combat, changes) => {
    if (!isPrimaryGM()) return;
    if (changes?.round === undefined && changes?.turn === undefined) return;
    sweepExpired(combat).catch((err) => console.error(`${MODULE_ID} | recharge sweep`, err));
  });
}

/** Encounter over: drop every cooldown this module rolled during it. */
async function clearRechargesFor(combat) {
  for (const combatant of combat.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    // Only markers we rolled. One a GM staged by hand and never used stays put.
    const ours = actor.items.filter(
      (i) => i.getFlag?.(MODULE_ID, "izirRecharge") && i.getFlag?.(MODULE_ID, "izirRolled"),
    );
    if (ours.length) {
      await actor.deleteEmbeddedDocuments("Item", ours.map((i) => i.id)).catch(() => {});
    }
  }
}

async function sweepExpired(combat) {
  // pf2e's own EffectTracker removes expired effects when the world automation is
  // on, in the same tick. Sweeping on top of it means two deletes for one document
  // and a console error for the loser. Stand down and let pf2e do it. (F34)
  if (game.pf2e?.settings?.automation?.removeEffects) return;

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    const expired = actor.items.filter(
      (i) => i.getFlag?.(MODULE_ID, "izirRecharge") && (i.isExpired === true || i.system?.expired === true),
    );
    // Re-check the ids at delete time: another client may have removed them while
    // this loop was awaiting an earlier actor.
    const ids = expired.map((i) => i.id).filter((id) => actor.items.get?.(id));
    if (ids.length) {
      await actor
        .deleteEmbeddedDocuments("Item", ids)
        .catch((err) => console.warn(`${MODULE_ID} | recharge sweep`, err));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Sheet shim: grey a recharging ability's Use button on every client  */
/* ------------------------------------------------------------------ */

/**
 * Presentational shim on every client: while a recharge effect is active, grey the
 * ability's Use button and show the remaining rounds. Enforcement never depends on
 * this; if a pf2e update shifts the sheet DOM, the whisper guard still holds.
 */
export function rechargeSheetShim(app, root) {
  const actor = app?.actor ?? app?.document;
  if (!actor || !isMarked(actor)) return;
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId || item.type !== "action") continue;
    // An expired marker the world never removed must not keep the button greyed. (F4)
    const marker = findRechargeEffect(actor, tag.entryId);
    const running = isRunning(marker) ? marker : null;
    const row = root.querySelector?.(`[data-item-id="${item.id}"]`);
    if (!row) continue;
    const btn = row.querySelector('button[data-action="use-action"], [data-action="use-action"]');
    if (!btn) continue;
    if (running) {
      const rounds = remainingRounds(running);
      btn.disabled = true;
      btn.classList.add("izir-recharging");
      btn.dataset.tooltip = game.i18n.format("SHARDS.Izir.StillRecharging", { name: item.name, rounds });
      if (!row.querySelector(".izir-cd")) {
        const badge = document.createElement("span");
        badge.className = "izir-cd";
        badge.textContent = game.i18n.format("SHARDS.Izir.RoundsShort", { rounds });
        btn.before(badge);
      }
    }
  }
}
