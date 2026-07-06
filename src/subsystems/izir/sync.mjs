/**
 * Foundry side of the composed model. One effect ("Izir — Immersion") carries every
 * passive and price as rule elements; action-form actives are separate sheet items.
 * All changes converge through syncActor: compose → diff → in-place update (no
 * delete-and-recreate churn). The effect's counter badge is two-way: editing it on
 * the token or sheet IS a level change.
 */

import { MODULE_ID, IZIR, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readIzir, patchIzir, appendLog, isMarked, listMarkedActors } from "./state.mjs";
import { composeEffect, composeActions, diffAll, EFFECT_ENTRY_ID } from "./logic/reconcile.mjs";
import { clampLevel, tierForLevel, MAX_LEVEL } from "./logic/model.mjs";
import { loadContent } from "./content.mjs";

const PUBLICATION = { title: "The Shards", authors: "Zeitcatcher", license: "OGL", remaster: true };
const MARKER_IMG = "icons/magic/perception/eye-ringed-glow-angry-red.webp";
const NINEVEH_IMG = "icons/magic/death/skull-horned-worn-fire-blue.webp";
const SUBJUGATED_IMG = "icons/magic/control/buff-flight-wings-runes-purple.webp";
const DEFAULT_ACTION_IMG = "icons/magic/unholy/strike-beam-blood-red-purple.webp";

const transparencyOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TRANSPARENCY) === true;
const tokenIconsOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TOKEN_ICONS) === true;

const charLevelOf = (actor) => Math.max(1, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 1) || 1);

function tagFlags(entryId, hash) {
  return { [MODULE_ID]: { izir: { entryId, contentHash: hash } } };
}

/* ------------------------------------------------------------------ */
/* Item builders                                                       */
/* ------------------------------------------------------------------ */

function effectDescription(composed) {
  const t = (k, d) => game.i18n.localize(k) ?? d;
  const parts = [];
  const tierName = game.i18n.localize(`SHARDS.Izir.Tier.${composed.tier}`);
  parts.push(`<p><em>${t("SHARDS.Izir.Immersion")} ${composed.level} — ${tierName}.</em></p>`);
  if (composed.terminal === "nineveh") {
    parts.push(`<p>${t("SHARDS.Izir.TerminalNineveh")}</p>`);
    return parts.join("\n");
  }
  if (composed.terminal === "subjugated") parts.push(`<p>${t("SHARDS.Izir.TerminalSubjugated")}</p>`);
  if (composed.boonLines.length) {
    parts.push(`<h3>${t("SHARDS.Izir.Gifts")}</h3>`);
    for (const b of composed.boonLines) parts.push(`<p><strong>${b.name}.</strong></p>${b.description}`);
  }
  if (composed.priceLines.length) {
    parts.push(`<h3>${t("SHARDS.Izir.Prices")}</h3>`);
    for (const p of composed.priceLines) parts.push(`<p><strong>${p.name}.</strong></p>${p.description}`);
  }
  return parts.join("\n");
}

function effectImg(composed) {
  if (composed.terminal === "nineveh") return NINEVEH_IMG;
  if (composed.terminal === "subjugated") return SUBJUGATED_IMG;
  return MARKER_IMG;
}

/** Full item source for the composed effect. */
export function buildEffectSource(composed) {
  return {
    name: game.i18n.localize("SHARDS.Izir.MarkerName"),
    type: "effect",
    img: effectImg(composed),
    system: {
      description: { value: effectDescription(composed) },
      slug: "shards-izir-immersion",
      duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
      unidentified: false,
      level: { value: 1 },
      tokenIcon: { show: tokenIconsOn() },
      badge: { type: "counter", value: composed.badge.value, min: 1, max: composed.badge.max },
      traits: { value: [], rarity: "common" },
      rules: composed.rules,
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: tagFlags(EFFECT_ENTRY_ID, composed.hash),
  };
}

/** Full item source for an action-form active. */
export function buildActionSource(desired) {
  const a = desired.actionData ?? {};
  return {
    name: desired.name,
    type: "action",
    img: desired.img || DEFAULT_ACTION_IMG,
    system: {
      description: { value: desired.description ?? "" },
      slug: `shards-izir-${desired.entryId}`,
      actionType: { value: a.actionType ?? "action" },
      actions: { value: a.actions ?? null },
      category: a.category ?? null,
      traits: { value: a.traits ?? [], rarity: "common" },
      frequency: a.frequency ?? null,
      rules: [],
      publication: PUBLICATION,
    },
    flags: tagFlags(desired.entryId, desired.hash),
  };
}

/* ------------------------------------------------------------------ */
/* Projection + convergence                                            */
/* ------------------------------------------------------------------ */

/** Project the actor's module-tagged items (recharge effects excluded). */
export function projectTagged(actor) {
  const out = [];
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId) continue;
    out.push({ itemId: item.id, entryId: tag.entryId, contentHash: tag.contentHash });
  }
  return out;
}

// Guard so our own writes don't re-trigger the watchers.
const syncing = new Set();
export const isSyncing = (actorId) => syncing.has(actorId);

/** Converge one actor's items to the composed model. Idempotent; GM-side. */
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
  const opts = { transparency: transparencyOn(), charLevel: charLevelOf(actor) };
  const marked = isMarked(actor);
  const effect = marked ? composeEffect(state, content, opts) : null;
  const actions = marked ? composeActions(state, content, opts) : [];
  const { toCreate, toUpdate, toDeleteIds } = diffAll(effect, actions, projectTagged(actor));
  if (!toCreate.length && !toUpdate.length && !toDeleteIds.length) return;

  syncing.add(actor.id);
  try {
    if (toDeleteIds.length) await actor.deleteEmbeddedDocuments("Item", [...new Set(toDeleteIds)]);
    if (toCreate.length) {
      const datas = toCreate.map((d) => (d.entryId === EFFECT_ENTRY_ID ? buildEffectSource(d) : buildActionSource(d)));
      await actor.createEmbeddedDocuments("Item", datas);
    }
    if (toUpdate.length) {
      const updates = toUpdate.map(({ itemId, desired }) => {
        const src = desired.entryId === EFFECT_ENTRY_ID ? buildEffectSource(desired) : buildActionSource(desired);
        return { _id: itemId, name: src.name, img: src.img, system: src.system, flags: src.flags };
      });
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

/* ------------------------------------------------------------------ */
/* Watchers                                                            */
/* ------------------------------------------------------------------ */

const timers = new Map();
function scheduleResync(actor) {
  const id = actor.uuid;
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      syncActor(actor).catch((err) => console.error(`${MODULE_ID} | resync`, err));
    }, 250),
  );
}

/** Badge edits, manual deletions, and character level-ups all feed back into sync. */
export function registerSyncHooks(onLevelFromBadge) {
  // Self-heal: a manually deleted module item is restored (suppress in the panel instead).
  Hooks.on("deleteItem", (item) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actor.id)) return;
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId || !isMarked(actor)) return;
    scheduleResync(actor);
  });

  // Two-way badge: click-adjusting the counter on the effect IS a level change.
  Hooks.on("updateItem", (item, changes) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actor.id)) return;
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (tag?.entryId !== EFFECT_ENTRY_ID || !isMarked(actor)) return;
    const badge = changes?.system?.badge?.value;
    if (badge === undefined || badge === null) return;
    const st = readIzir(actor);
    if (st.terminal) {
      scheduleResync(actor); // terminal badge is fixed — snap it back
      return;
    }
    const next = clampLevel(Math.min(badge, MAX_LEVEL - 1));
    if (next === st.level) return;
    Promise.resolve(onLevelFromBadge?.(actor, st.level, next)).catch((err) =>
      console.error(`${MODULE_ID} | badge level change`, err),
    );
  });

  // Character level-up: baked attack/DC numbers must be recomputed.
  Hooks.on("updateActor", (actor, changes) => {
    if (!isPrimaryGM()) return;
    if (syncing.has(actor.id) || !isMarked(actor)) return;
    if (changes?.system?.details?.level?.value === undefined) return;
    scheduleResync(actor);
  });
}

/** Tier id for display, terminal-aware (shared by panel + others). */
export function displayTier(state) {
  if (state.terminal === "subjugated") return "subjugated";
  if (state.terminal === "nineveh") return "nineveh";
  return tierForLevel(state.level).id;
}
