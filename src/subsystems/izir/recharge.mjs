/**
 * Dragon-style recharge for Izir actives. When a recharge-tagged action is posted
 * to chat during combat, the module rolls the recharge die (1d6 by default), shows
 * the roll, and applies a self-expiring "Recharge: <ability>" effect measured in
 * rounds. Out of combat there is no cooldown to track. The reconciler ignores
 * these transient effects (they carry their own flag, not the sync tag).
 */

import { MODULE_ID, IZIR } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { loadContent } from "./content.mjs";

const RECHARGE_IMG = "icons/magic/time/hourglass-yellow.webp";

/** Is this actor currently in the active, started combat? */
function inActiveCombat(actor) {
  const combat = game.combat;
  if (!combat?.started) return false;
  return combat.combatants.some((c) => c.actor === actor || c.actor?.uuid === actor.uuid);
}

function rechargeSlug(entryId) {
  return `shards-izir-recharge-${entryId}`;
}

function hasRecharge(actor, entryId) {
  return actor.items.some((i) => i.type === "effect" && i.system?.slug === rechargeSlug(entryId));
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
      // izirRecharge, NOT the sync tag — projectTagged must ignore these.
      flags: { [MODULE_ID]: { izirRecharge: entry.id } },
    },
  ]);
}

/** Register the chat watcher. Primary GM only. Call on ready. */
export function registerRechargeHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    handleMessage(message).catch((err) => console.error(`${MODULE_ID} | recharge`, err));
  });
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

  if (!inActiveCombat(actor)) return; // no cooldowns outside combat
  if (hasRecharge(actor, entry.id)) return; // already recharging — GM adjudicates spam

  await applyRecharge(actor, item, entry);
}
