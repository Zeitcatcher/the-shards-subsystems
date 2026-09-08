/**
 * Foundry side of the composed model. One effect ("Izir — Immersion") carries every
 * passive and price as rule elements; action-form actives are separate sheet items.
 * All changes converge through syncActor: compose → diff → in-place update (no
 * delete-and-recreate churn). The effect's counter badge is two-way: editing it on
 * the token or sheet IS a level change.
 */

import { MODULE_ID, IZIR, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../core/platform.mjs";
import { readIzir, patchIzir, appendLog, isMarked, listMarkedActors } from "./state.mjs";
import { composeEffect, composeActions, diffAll, packUuid, EFFECT_ENTRY_ID } from "./logic/reconcile.mjs";
import { clampLevel, tierForLevel, MAX_LEVEL } from "./logic/model.mjs";
import { loadContent } from "./content.mjs";

const PUBLICATION = { title: "The Shards", authors: "Zeitcatcher", license: "ORC", remaster: true };
const MARKER_IMG = "icons/magic/perception/eye-ringed-glow-angry-red.webp";
const NINEVEH_IMG = "icons/magic/death/skull-horned-worn-fire-blue.webp";
const SUBJUGATED_IMG = "icons/magic/control/buff-flight-wings-runes-purple.webp";
const DEFAULT_ACTION_IMG = "icons/magic/unholy/projectile-helix-blood-red.webp";

const transparencyOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TRANSPARENCY) === true;
const tokenIconsOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_TOKEN_ICONS) === true;

const charLevelOf = (actor) => Math.max(1, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 1) || 1);

function tagFlags(entryId, hash) {
  return { [MODULE_ID]: { izir: { entryId, contentHash: hash } } };
}

/** Deterministic 16-char id, same rule as the pack build script's makeId. */
const makeId = (s) => s.replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0").slice(0, 16);

/** The pack UUID of an entry's generated "Recharge: <name>" effect. */
export function rechargeEffectUuid(entryId) {
  return packUuid(makeId(`rc-${entryId}`));
}

/* ------------------------------------------------------------------ */
/* Item builders                                                       */
/* ------------------------------------------------------------------ */

function effectDescription(composed) {
  const t = (k) => game.i18n.localize(k);
  const parts = [];
  const tierName = game.i18n.localize(`SHARDS.Izir.Tier.${composed.tier}`);
  parts.push(`<p><em>${t("SHARDS.Izir.Immersion")} ${composed.level}: ${tierName}.</em></p>`);
  if (composed.terminal === "nineveh") {
    parts.push(`<p>${t("SHARDS.Izir.TerminalNineveh")}</p>`);
    return parts.join("\n");
  }
  if (composed.terminal === "subjugated") parts.push(`<p>${t("SHARDS.Izir.TerminalSubjugated")}</p>`);
  if (composed.boonLines.length) {
    parts.push(`<h3>${t("SHARDS.Izir.Gifts")}</h3>`);
    for (const b of composed.boonLines) parts.push(`<p><strong>${b.name}.</strong></p>${b.description}`);
  }
  if (composed.abilityLines.length) {
    parts.push(`<h3>${t("SHARDS.Izir.Abilities")}</h3><ul>`);
    for (const a of composed.abilityLines) {
      const glyph = a.glyph ? ` <strong>${a.glyph}</strong>` : "";
      const tag = a.tag ? ` <em>· ${a.tag}</em>` : "";
      parts.push(`<li><strong>${a.name}</strong>${glyph}${tag}</li>`);
    }
    parts.push("</ul>");
  }
  if (composed.priceLines.length) {
    parts.push(`<h3>${t("SHARDS.Izir.Prices")}</h3>`);
    for (const p of composed.priceLines) parts.push(`<p><strong>${p.name}.</strong></p>${p.description}`);
  }
  if (composed.hiddenPrices > 0) {
    parts.push(`<p><em>${game.i18n.format("SHARDS.Izir.UnseenPrices", { n: composed.hiddenPrices })}</em></p>`);
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
      tokenIcon: { show: composed.tokenIcons !== false },
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
  const system = {
    description: { value: desired.description ?? "" },
    slug: `shards-izir-${desired.entryId}`,
    actionType: { value: a.actionType ?? "action" },
    actions: { value: a.actions ?? null },
    category: a.category ?? null,
    traits: { value: a.traits ?? [], rarity: "common" },
    frequency: a.frequency ?? null,
    rules: [],
    publication: PUBLICATION,
  };
  // Rage-pattern self-applied effect (e.g. Herald of Ruin's flight minute).
  // `selfEffect` is always written, null included: leaving the key out of an
  // update payload leaves a stale uuid behind when an ability stops using one. (F9)
  if (a.selfEffectId) {
    system.selfEffect = { uuid: packUuid(a.selfEffectId), name: desired.name };
  } else if (a.recharge) {
    // Recharge actives get their Use button from a selfEffect pointing at the
    // generated Recharge effect (pf2e: usable = selfEffect || frequency).
    system.selfEffect = {
      uuid: rechargeEffectUuid(desired.entryId),
      name: game.i18n.format("SHARDS.Izir.RechargeEffect", { name: desired.name }),
    };
  } else {
    system.selfEffect = null;
  }
  return {
    name: desired.name,
    type: "action",
    img: desired.img || DEFAULT_ACTION_IMG,
    system,
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

// Guard so our own writes don't re-trigger the watchers. Keyed by uuid, not
// actor.id: a synthetic (unlinked token) actor carries the BASE actor's id, so
// two tokens of one statblock shared a key and one token's guard swallowed the
// other's work. pf2e guards against the same confusion at actor/base.ts:171. (H2)
const syncing = new Set();
export const isSyncing = (actor) => syncing.has(actorKey(actor));

// Per-actor promise chain so overlapping syncs serialize (see syncActor).
const syncChain = new Map();

/**
 * Converge one actor's items to the composed model. Idempotent; GM-side.
 * Returns the number of item operations performed, so a caller can say honestly
 * whether anything moved.
 *
 * `{ force: true }` rewrites every tagged item even when the hash matches. The
 * hash only covers what we compose, so a change on the pf2e side — a pack uuid
 * moving, a schema field we now emit — leaves stale items looking up to date. (F9)
 */
export async function syncActor(actor, opts = {}) {
  if (!actor) return 0;
  // Serialize per actor: two overlapping runs must not each project "no effect
  // yet" and both create the composed effect before either write lands. (C1)
  const key = actorKey(actor);
  const prev = syncChain.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => syncActorInner(actor, opts));
  syncChain.set(key, run);
  try {
    return await run;
  } finally {
    if (syncChain.get(key) === run) syncChain.delete(key);
  }
}

async function syncActorInner(actor, { force = false } = {}) {
  let content;
  try {
    content = await loadContent();
  } catch (err) {
    console.error(`${MODULE_ID} | content unavailable, skipping sync`, err);
    return 0;
  }

  const state = readIzir(actor);
  // actorType decides how the Izir strike gets its attack bonus: pf2e honours a
  // Strike RE's flat attackModifier on NPCs only. (F1)
  const opts = {
    transparency: transparencyOn(),
    charLevel: charLevelOf(actor),
    actorType: actor.type,
    tokenIcons: tokenIconsOn(),
  };
  const marked = isMarked(actor);
  const effect = marked ? composeEffect(state, content, opts) : null;
  const actions = marked ? composeActions(state, content, opts) : [];
  const tagged = projectTagged(actor);
  const { toCreate, toUpdate, toDeleteIds } = diffAll(effect, actions, tagged);

  // A forced run rewrites every tagged item that is still wanted, hash or no hash.
  if (force) {
    const desiredById = new Map([...(effect ? [effect] : []), ...actions].map((d) => [d.entryId, d]));
    for (const t of tagged) {
      const d = desiredById.get(t.entryId);
      if (!d || toDeleteIds.includes(t.itemId) || toUpdate.some((u) => u.itemId === t.itemId)) continue;
      toUpdate.push({ itemId: t.itemId, desired: d });
    }
  }

  // Force-refresh the composed effect when its live badge was nudged out of sync.
  // The badge value isn't part of the composed hash, so a terminal's fixed badge
  // (or a badge edit that shouldn't change level) wouldn't otherwise snap back. (C3)
  if (effect) {
    const t = tagged.find((x) => x.entryId === EFFECT_ENTRY_ID);
    if (t && !toUpdate.some((u) => u.itemId === t.itemId)) {
      const live = actor.items.get(t.itemId)?.system?.badge?.value;
      if (live !== undefined && live !== effect.badge?.value) toUpdate.push({ itemId: t.itemId, desired: effect });
    }
  }

  if (!toCreate.length && !toUpdate.length && !toDeleteIds.length) return 0;

  const key = actorKey(actor);
  syncing.add(key);
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
    syncing.delete(key);
  }
  warnDroppedRules(actor, effect);
  return toCreate.length + toUpdate.length + toDeleteIds.length;
}

/**
 * Diagnostic: pf2e silently drops rule elements that fail schema validation. After a
 * sync, compare what we composed against what actually applied and name the missing
 * keys, so "something isn't showing" is a console line instead of a mystery.
 */
function warnDroppedRules(actor, composed) {
  try {
    if (!composed) return;
    const item = actor.items.find((i) => i.getFlag?.(MODULE_ID, IZIR)?.entryId === EFFECT_ENTRY_ID);
    if (!item) return;
    const applied = (actor.rules ?? []).filter((r) => r.item?.id === item.id && !r.ignored);
    if (applied.length >= composed.rules.length) return;
    const missing = composed.rules.map((r) => r.key);
    for (const r of applied) {
      const i = missing.indexOf(r.key);
      if (i >= 0) missing.splice(i, 1);
    }
    console.warn(
      `${MODULE_ID} | ${missing.length} rule element(s) on "${actor.name}" were rejected by pf2e validation: ${missing.join(", ")} — see pf2e's own warning above for the field it disliked.`,
    );
  } catch {
    /* diagnostic only — never break a sync */
  }
}

/** Sync every marked actor (e.g. after a transparency change). Primary GM only. */
export async function syncAllMarked(opts = {}) {
  // null, not 0: "I declined" and "nothing needed doing" are different answers,
  // and a co-GM used to be told "all marked actors re-synced" after this bailed. (F27)
  if (!isPrimaryGM()) return null;
  let changed = 0;
  for (const actor of listMarkedActors()) {
    changed += (await syncActor(actor, opts).catch((err) => {
      console.error(`${MODULE_ID} | syncAllMarked`, err);
      return 0;
    })) ?? 0;
  }
  return changed;
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
export function registerSyncHooks(onLevelFromBadge, onFlagChange) {
  // Self-heal: a manually deleted module item is restored (suppress in the panel instead).
  Hooks.on("deleteItem", (item, _options, userId) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actorKey(actor))) return;
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId || !isMarked(actor)) return;

    // pf2e's counter badge deletes the effect at its minimum instead of going to
    // zero, so right-clicking the counter at immersion 1 made the icon blink and
    // come back at 1 — while the panel stepper reaches 0 fine. Read the delete as
    // the level change it plainly is. (F24)
    const st = readIzir(actor);
    if (
      tag.entryId === EFFECT_ENTRY_ID &&
      st.level === 1 &&
      !st.terminal &&
      game.users?.get(userId)?.isGM
    ) {
      Promise.resolve(onLevelFromBadge?.(actor, 1, 0)).catch((err) =>
        console.error(`${MODULE_ID} | badge level change`, err),
      );
      return;
    }
    scheduleResync(actor);
  });

  // Two-way badge: click-adjusting the counter on the effect IS a level change.
  Hooks.on("updateItem", (item, changes, _options, userId) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actorKey(actor))) return;
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (tag?.entryId !== EFFECT_ENTRY_ID || !isMarked(actor)) return;
    const badge = changes?.system?.badge?.value;
    if (badge === undefined || badge === null) return;
    // Only a GM drives the level from the badge. A player editing their own effect
    // counter is snapped back (resync recomposes at the unchanged level). (C2)
    if (!game.users?.get(userId)?.isGM) {
      scheduleResync(actor);
      return;
    }
    const st = readIzir(actor);
    if (st.terminal) {
      scheduleResync(actor); // terminal badge is fixed — snap it back (C3)
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
    if (syncing.has(actorKey(actor)) || !isMarked(actor)) return;
    if (changes?.system?.details?.level?.value === undefined) return;
    scheduleResync(actor);
  });

  // Read-only, on EVERY client: a co-GM's open panel used to sit on stale numbers
  // until they happened to click something, because every watcher here is gated on
  // the primary GM. (F27)
  Hooks.on("updateActor", (_actor, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${IZIR}`)) onFlagChange?.();
  });
}

/** Tier id for display, terminal-aware (shared by panel + others). */
export function displayTier(state) {
  if (state.terminal === "subjugated") return "subjugated";
  if (state.terminal === "nineveh") return "nineveh";
  return tierForLevel(state.level).id;
}
