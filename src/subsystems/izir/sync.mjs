/**
 * Foundry side of reconciliation. Builds pf2e items from content entries, projects
 * the actor's currently-tagged items, and converges them via batched embedded-document
 * CRUD. The panel never touches items directly — it mutates flags then calls syncActor.
 */

import { MODULE_ID, IZIR, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readIzir, isMarked, listMarkedActors } from "./state.mjs";
import { computeDesired, diffItems } from "./logic/reconcile.mjs";
import { tierForLevel } from "./logic/model.mjs";
import { loadContent } from "./content.mjs";

const PUBLICATION = { title: "The Shards", authors: "Zeitcatcher", license: "OGL", remaster: true };
const DEFAULT_EFFECT_IMG = "icons/magic/unholy/orb-glowing-purple.webp";
const DEFAULT_ACTION_IMG = "icons/magic/unholy/strike-beam-blood-red-purple.webp";
const MARKER_IMG = "icons/magic/perception/eye-ringed-glow-angry-red.webp";
const NINEVEH_IMG = "icons/magic/death/skull-horned-worn-fire-blue.webp";
const SUBJUGATED_IMG = "icons/magic/control/buff-flight-wings-runes-purple.webp";

const transparencyOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TRANSPARENCY) === true;
const tokenIconsOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TOKEN_ICONS) === true;

function tagFlags(desired) {
  return { [MODULE_ID]: { izir: { entryId: desired.entryId, family: desired.family, contentHash: desired.hash } } };
}

function buildMarker(desired) {
  const { level, terminal } = desired.marker;
  const tierTag = terminal ?? tierForLevel(level).id;
  const img = terminal === "nineveh" ? NINEVEH_IMG : terminal === "subjugated" ? SUBJUGATED_IMG : MARKER_IMG;
  return {
    name: game.i18n.localize("SHARDS.Izir.MarkerName"),
    type: "effect",
    img,
    system: {
      description: { value: "" },
      slug: "shards-izir-marker",
      duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
      unidentified: false,
      level: { value: 1 },
      tokenIcon: { show: true },
      badge: { type: "counter", value: Math.max(1, level), min: 1, max: 10 },
      traits: { value: [], rarity: "common" },
      rules: [
        { key: "RollOption", domain: "all", option: "self:shards:izir" },
        { key: "RollOption", domain: "all", option: `self:shards:izir:level:${level}` },
        { key: "RollOption", domain: "all", option: `self:shards:izir:tier:${tierTag}` },
      ],
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: tagFlags(desired),
  };
}

function buildEffect(desired) {
  const e = desired.entry;
  return {
    name: e.name,
    type: "effect",
    img: e.img || DEFAULT_EFFECT_IMG,
    system: {
      description: { value: e.description ?? "" },
      slug: `shards-izir-${e.id}`,
      duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
      unidentified: !desired.identified,
      level: { value: 1 },
      tokenIcon: { show: tokenIconsOn() },
      badge: null,
      traits: { value: [], rarity: "common" },
      rules: Array.isArray(e.rules) ? e.rules : [],
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: tagFlags(desired),
  };
}

function buildAction(desired) {
  const e = desired.entry;
  const a = e.actionData ?? {};
  return {
    name: e.name,
    type: "action",
    img: e.img || DEFAULT_ACTION_IMG,
    system: {
      description: { value: e.description ?? "" },
      slug: `shards-izir-${e.id}`,
      actionType: { value: a.actionType ?? "action" },
      actions: { value: a.actions ?? null },
      category: a.category ?? null,
      traits: { value: a.traits ?? [], rarity: "common" },
      frequency: a.frequency ?? null,
      rules: Array.isArray(e.rules) ? e.rules : [],
      publication: PUBLICATION,
    },
    flags: tagFlags(desired),
  };
}

/** Build the pf2e item document data for one desired entry (null if unsupported). */
export function buildItemData(desired) {
  switch (desired.form) {
    case "marker":
      return buildMarker(desired);
    case "effect":
      return buildEffect(desired);
    case "action":
      return buildAction(desired);
    case "spell":
      // Spell-form actives (managed innate entry) arrive in M4 with skill-authored spells.
      console.warn(`${MODULE_ID} | spell-form active not yet built: ${desired.entryId}`);
      return null;
    default:
      return null;
  }
}

/** Project the actor's module-tagged items into the shape diffItems expects. */
export function projectTagged(actor) {
  const out = [];
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId) continue;
    out.push({
      itemId: item.id,
      entryId: tag.entryId,
      family: tag.family,
      contentHash: tag.contentHash,
      identified: item.system?.unidentified ? false : true,
    });
  }
  return out;
}

// Guard so our own create/delete during a sync doesn't trigger the deleteItem watcher.
const syncing = new Set();

/** Converge one actor's items to the desired set. Idempotent; GM-side. */
export async function syncActor(actor) {
  if (!actor) return;
  let content;
  try {
    content = await loadContent();
  } catch (err) {
    console.error(`${MODULE_ID} | content unavailable, skipping sync`, err);
    return;
  }

  const state = readIzir(actor);
  const desired = isMarked(actor) ? computeDesired(state, content, { transparency: transparencyOn() }) : [];
  const tagged = projectTagged(actor);
  const { toCreate, toDelete, toUpdate } = diffItems(desired, tagged);
  if (!toCreate.length && !toDelete.length && !toUpdate.length) return;

  syncing.add(actor.id);
  try {
    if (toDelete.length) {
      const ids = [...new Set(toDelete.map((t) => t.itemId))];
      await actor.deleteEmbeddedDocuments("Item", ids);
    }
    if (toCreate.length) {
      const datas = toCreate.map(buildItemData).filter(Boolean);
      if (datas.length) await actor.createEmbeddedDocuments("Item", datas);
    }
    if (toUpdate.length) {
      const updates = toUpdate.map((u) => ({ _id: u.tagged.itemId, "system.unidentified": !u.desired.identified }));
      await actor.updateEmbeddedDocuments("Item", updates);
    }
  } finally {
    syncing.delete(actor.id);
  }
}

/** Sync every marked actor (e.g. after a transparency change). Primary GM only. */
export async function syncAllMarked() {
  if (!isPrimaryGM()) return;
  for (const actor of listMarkedActors()) {
    await syncActor(actor).catch((err) => console.error(`${MODULE_ID} | syncAllMarked`, err));
  }
}

// Debounced self-heal: if a GM manually deletes a tagged item, restore it unless it's
// been suppressed in the panel.
const timers = new Map();
function scheduleResync(actor) {
  const id = actor.id;
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      syncActor(actor).catch((err) => console.error(`${MODULE_ID} | resync`, err));
    }, 250),
  );
}

/** Register the deletion-resilience hook. Primary GM only. Call on ready. */
export function registerSyncHooks() {
  Hooks.on("deleteItem", (item) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actor.id)) return;
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId || !isMarked(actor)) return;
    scheduleResync(actor);
  });
}
