/**
 * Dragon-style recharge for Izir actives, with the module owning the sheet's
 * use-state. Each recharge active carries a 1/day frequency purely so pf2e renders
 * the Use button and pips; the module zeroes the use when the ability fires in
 * combat and restores it the moment the rolled Recharge effect ends. Out of combat
 * there is no cooldown, so a click just gets its use handed straight back.
 */

import { MODULE_ID, IZIR } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { loadContent } from "./content.mjs";

const RECHARGE_IMG = "icons/magic/time/hourglass-tilted-glowing-gold.webp";

/** Is this actor currently in the active, started combat? */
function inActiveCombat(actor) {
  const combat = game.combat;
  if (!combat?.started) return false;
  return combat.combatants.some((c) => c.actor === actor || c.actor?.uuid === actor.uuid);
}

function rechargeSlug(entryId) {
  return `shards-izir-recharge-${entryId}`;
}

function findRechargeEffect(actor, entryId) {
  return actor.items.find((i) => i.type === "effect" && i.system?.slug === rechargeSlug(entryId));
}

function findActionItem(actor, entryId) {
  return actor.items.find((i) => i.type === "action" && i.getFlag?.(MODULE_ID, IZIR)?.entryId === entryId);
}

/** Set the sheet's remaining uses for an entry's action item. */
async function setUses(actor, entryId, value) {
  const item = findActionItem(actor, entryId);
  if (!item || !item.system?.frequency) return;
  const max = item.system.frequency.max ?? 1;
  const target = Math.max(0, Math.min(value, max));
  if (item.system.frequency.value === target) return;
  await item.update({ "system.frequency.value": target });
}

async function applyRecharge(actor, item, entry) {
  const formula = entry.actionData?.recharge ?? "1d6";
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: game.i18n.format("SHARDS.Izir.RechargeFlavor", { name: item.name }),
  });
  const rounds = Math.max(1, roll.total);

  await actor.createEmbeddedDocuments("Item", [
    {
      name: game.i18n.format("SHARDS.Izir.RechargeEffect", { name: item.name }),
      type: "effect",
      img: RECHARGE_IMG,
      system: {
        description: {
          value: `<p>${game.i18n.format("SHARDS.Izir.RechargeDesc", { name: item.name, rounds })}</p>`,
        },
        slug: rechargeSlug(entry.id),
        duration: { value: rounds, unit: "rounds", sustained: false, expiry: "turn-start" },
        unidentified: false,
        level: { value: 1 },
        tokenIcon: { show: true },
        badge: null,
        traits: { value: [], rarity: "common" },
        rules: [],
        start: { value: 0, initiative: null },
        publication: { title: "The Shards", authors: "Zeitcatcher", license: "OGL", remaster: true },
      },
      // izirRecharge, NOT the sync tag: projectTagged must ignore these.
      flags: { [MODULE_ID]: { izirRecharge: entry.id } },
    },
  ]);
  await setUses(actor, entry.id, 0);
}

/** Register the chat watcher plus the restore/expiry hooks. Primary GM only. */
export function registerRechargeHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    handleMessage(message).catch((err) => console.error(`${MODULE_ID} | recharge`, err));
  });

  // The Recharge effect ended (expired and removed, or deleted by hand):
  // hand the use back.
  Hooks.on("deleteItem", (item) => {
    if (!isPrimaryGM()) return;
    const entryId = item.getFlag?.(MODULE_ID, "izirRecharge");
    const actor = item.parent;
    if (!entryId || !actor) return;
    setUses(actor, entryId, 99).catch((err) => console.error(`${MODULE_ID} | recharge restore`, err));
  });

  // pf2e leaves expired effects in place unless the world auto-removes them;
  // sweep our recharge markers on every round/turn change so uses come back on time.
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

async function handleMessage(message) {
  const originUuid = message.flags?.pf2e?.origin?.uuid;
  if (!originUuid) return;
  const item = fromUuidSync(originUuid);
  if (!item || item.documentName !== "Item" || item.type !== "action") return;
  const actor = item.parent;
  if (!actor) return;

  const tag = item.getFlag?.(MODULE_ID, IZIR);
  if (!tag?.entryId) return;

  const content = await loadContent().catch(() => null);
  const entry = content?.byId?.get(tag.entryId);
  if (!entry?.actionData?.recharge) return;

  const running = findRechargeEffect(actor, entry.id);
  if (running) {
    // Still recharging: keep the use at zero and tell the GM.
    await setUses(actor, entry.id, 0);
    const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    await ChatMessage.create({
      content: `<div class="izir-temptation-card"><p>${game.i18n.format("SHARDS.Izir.StillRecharging", { name: item.name })}</p></div>`,
      whisper: gmIds,
      speaker: ChatMessage.getSpeaker({ actor }),
    });
    return;
  }

  if (inActiveCombat(actor)) {
    await applyRecharge(actor, item, entry);
  } else {
    // No cooldown outside combat: undo the click's use so the button stays live.
    await setUses(actor, entry.id, 99);
  }
}
