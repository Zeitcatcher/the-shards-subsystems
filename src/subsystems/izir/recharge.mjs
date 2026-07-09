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

import { MODULE_ID, IZIR } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { loadContent } from "./content.mjs";

const RECHARGE_IMG = "icons/magic/time/hourglass-tilted-glowing-gold.webp";

/** Is this actor currently in the active, started combat? */
export function inActiveCombat(actor) {
  const combat = game.combat;
  if (!combat?.started) return false;
  return combat.combatants.some((c) => c.actor === actor || c.actor?.uuid === actor.uuid);
}

/** The active recharge marker for an entry, if any. */
export function findRechargeEffect(actor, entryId) {
  return actor.items.find((i) => i.type === "effect" && i.getFlag?.(MODULE_ID, "izirRecharge") === entryId);
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
  await ChatMessage.create({
    content: `<div class="izir-temptation-card"><p>${game.i18n.format("SHARDS.Izir.StillRecharging", { name, rounds })}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
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
  const gateKey = `${actor.id}:${entry.id}`;
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

  // Out of combat there is no cooldown to track.
  if (!inActiveCombat(actor)) {
    if (!item.getFlag(MODULE_ID, "izirRolled")) await item.delete();
    return;
  }

  // A rolled marker already exists: this copy is a duplicate.
  const sibling = actor.items.find(
    (i) => i.id !== item.id && i.getFlag?.(MODULE_ID, "izirRecharge") === entryId,
  );
  if (sibling) {
    await item.delete();
    await whisperStillRecharging(actor, sibling.name, remainingRounds(sibling));
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

  // pf2e leaves expired effects in place unless the world auto-removes them;
  // sweep our markers on round/turn changes so abilities come back on time.
  Hooks.on("updateCombat", (combat, changes) => {
    if (!isPrimaryGM()) return;
    if (changes?.round === undefined && changes?.turn === undefined) return;
    sweepExpired(combat).catch((err) => console.error(`${MODULE_ID} | recharge sweep`, err));
  });
}

async function sweepExpired(combat) {
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    const expired = actor.items.filter(
      (i) => i.getFlag?.(MODULE_ID, "izirRecharge") && (i.isExpired === true || i.system?.expired === true),
    );
    if (expired.length) await actor.deleteEmbeddedDocuments("Item", expired.map((i) => i.id));
  }
}
