/**
 * Foundry side of the composed Ansu model. Up to two effects (the persistent
 * "Ansu — Attunement" marker with the two-way badge + Inheritance rules, and the
 * stateful "Ansu — Communion" carrying every other boon) plus one sheet item per
 * action-form active. All changes converge through syncActor: compose → diff →
 * in-place update (no delete-and-recreate churn).
 */

import { MODULE_ID, ANSU, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readAnsu, isAttuned, listAttunedActors } from "./state.mjs";
import {
  composeAttunement,
  composeCommunion,
  composeActions,
  composeFeats,
  diffAll,
  durationLabel,
  ATTUNEMENT_ENTRY_ID,
  COMMUNION_ENTRY_ID,
} from "./logic/reconcile.mjs";
import { clampLevel, tierForLevel, MAX_LEVEL } from "./logic/model.mjs";
import { loadContent } from "./content.mjs";

const PUBLICATION = { title: "The Shards", authors: "Zeitcatcher", license: "OGL", remaster: true };
const MARKER_IMG = "icons/ancestries/minotaur.webp";
const COMMUNION_IMG = "icons/creatures/magical/spirit-fire-orange.webp";
const SEIZED_IMG = "icons/magic/control/control-influence-puppet.webp";
const MASTERY_IMG = "icons/magic/control/control-influence-crown-gold.webp";
const DEFAULT_ACTION_IMG = "icons/magic/control/buff-strength-muscle-damage-orange.webp";

const tokenIconsOn = () => game.settings.get(MODULE_ID, SETTINGS.ANSU_TOKEN_ICONS) === true;

const charLevelOf = (actor) => Math.max(1, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 1) || 1);

/** The GM-tunable number dials, read once per sync. */
export function readDials() {
  return {
    dcBase: Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_DC_BASE)) || 20,
    dcStep: Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_DC_STEP)) || 2,
    dcCap: Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_DC_CAP)) || 5,
    climbBase: Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CLIMB_BASE)) || 2,
    climbStep: Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CLIMB_STEP)) ?? 1,
  };
}

function tagFlags(entryId, hash, extra = {}) {
  return { [MODULE_ID]: { ansu: { entryId, contentHash: hash, ...extra } } };
}

/* ------------------------------------------------------------------ */
/* Item builders                                                       */
/* ------------------------------------------------------------------ */

function attunementDescription(composed) {
  const t = (k) => game.i18n.localize(k);
  const tierName = game.i18n.localize(`SHARDS.Ansu.Tier.${composed.tier}`);
  const parts = [];
  parts.push(`<p><em>${t("SHARDS.Ansu.Attunement")} ${composed.level} — ${tierName}.</em></p>`);
  if (composed.terminal === "taken") {
    parts.push(`<p>${t("SHARDS.Ansu.TerminalTaken")}</p>`);
  } else if (composed.terminal === "subjugated") {
    parts.push(`<p>${t("SHARDS.Ansu.TerminalSubjugated")}</p>`);
  } else {
    parts.push(
      `<p>${game.i18n.format("SHARDS.Ansu.MarkerSummary", {
        duration: durationLabel(composed.durationRounds),
        dc: composed.releaseDc,
      })}</p>`,
    );
  }
  if (composed.inheritanceLines.length) {
    parts.push(`<h3>${t("SHARDS.Ansu.Inheritance")}</h3>`);
    for (const b of composed.inheritanceLines) parts.push(`<p><strong>${b.name}.</strong></p>${b.description}`);
  }
  return parts.join("\n");
}

function attunementImg(composed) {
  if (composed.terminal === "taken") return SEIZED_IMG;
  if (composed.terminal === "subjugated") return MASTERY_IMG;
  return MARKER_IMG;
}

/** Full item source for the persistent Attunement marker. */
export function buildAttunementSource(composed) {
  return {
    name: game.i18n.localize("SHARDS.Ansu.MarkerName"),
    type: "effect",
    img: attunementImg(composed),
    system: {
      description: { value: attunementDescription(composed) },
      slug: "shards-ansu-attunement",
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
    flags: tagFlags(ATTUNEMENT_ENTRY_ID, composed.hash),
  };
}

function communionDescription(composed) {
  const t = (k) => game.i18n.localize(k);
  const parts = [];
  parts.push(`<p><em>${t(`SHARDS.Ansu.Mode.${composed.mode}`)}</em></p>`);
  if (composed.boonLines.length) {
    parts.push(`<h3>${t("SHARDS.Ansu.Boons")}</h3>`);
    for (const b of composed.boonLines) parts.push(`<p><strong>${b.name}.</strong></p>${b.description}`);
  }
  if (composed.abilityLines.length) {
    parts.push(`<h3>${t("SHARDS.Ansu.Abilities")}</h3><ul>`);
    for (const a of composed.abilityLines) {
      const glyph = a.glyph ? ` <strong>${a.glyph}</strong>` : "";
      const tag = a.tag ? ` <em>· ${a.tag}</em>` : "";
      parts.push(`<li><strong>${a.name}</strong>${glyph}${tag}</li>`);
    }
    parts.push("</ul>");
  }
  return parts.join("\n");
}

function communionImg(composed) {
  if (composed.mode === "seized" || composed.mode === "taken") return SEIZED_IMG;
  if (composed.mode === "permanent") return MASTERY_IMG;
  return COMMUNION_IMG;
}

/**
 * The Communion item's duration. Rounds tick only inside a started combat —
 * out of combat the effect is unlimited and the GM ends it from the panel.
 * Lingering and the terminals never expire on their own.
 */
export function communionDuration(composed, inCombat) {
  if (composed.permanent || composed.mode === "lingering" || composed.mode === "seized" || !inCombat) {
    return { value: -1, unit: "unlimited", sustained: false, expiry: null };
  }
  const rounds = Math.max(1, Number(composed.durationRounds) || 1);
  return { value: rounds, unit: "rounds", sustained: false, expiry: "turn-start" };
}

/** Full item source for the stateful Communion effect. */
export function buildCommunionSource(composed, { inCombat = false } = {}) {
  return {
    name: game.i18n.localize("SHARDS.Ansu.CommunionName"),
    type: "effect",
    img: communionImg(composed),
    system: {
      description: { value: communionDescription(composed) },
      slug: "shards-ansu-communion",
      duration: communionDuration(composed, inCombat),
      unidentified: false,
      level: { value: 1 },
      tokenIcon: { show: tokenIconsOn() },
      badge: null,
      traits: { value: [], rarity: "common" },
      rules: composed.rules,
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: tagFlags(COMMUNION_ENTRY_ID, composed.hash, { mode: composed.mode }),
  };
}

/** Full item source for an action-form active. */
export function buildActionSource(desired) {
  const a = desired.actionData ?? {};
  const system = {
    description: { value: desired.description ?? "" },
    slug: `shards-ansu-${desired.entryId}`,
    actionType: { value: a.actionType ?? "action" },
    actions: { value: a.actions ?? null },
    category: a.category ?? null,
    traits: { value: a.traits ?? [], rarity: "common" },
    frequency: a.frequency ?? null,
    rules: [],
    publication: PUBLICATION,
  };
  // Module-owned cooldowns bake the remaining uses (0 while cooling down);
  // ordinary frequencies leave `value` to pf2e so a resync can't refund a use.
  if (system.frequency && a.frequencyValue !== undefined && a.frequencyValue !== null) {
    system.frequency = { ...system.frequency, value: a.frequencyValue };
  }
  return {
    name: desired.name,
    type: "action",
    img: desired.img || DEFAULT_ACTION_IMG,
    system,
    flags: tagFlags(desired.entryId, desired.hash),
  };
}

/** Full item source for an Inheritance bonus feat (official pf2e feat shape). */
export function buildFeatSource(desired) {
  return {
    name: desired.name,
    type: "feat",
    img: desired.img || MARKER_IMG,
    system: {
      description: { value: desired.description ?? "" },
      slug: `shards-ansu-${desired.entryId}`,
      category: "bonus",
      level: { value: desired.level ?? 1 },
      actionType: { value: "passive" },
      actions: { value: null },
      prerequisites: { value: [] },
      traits: { value: [], rarity: "common" },
      frequency: null,
      rules: desired.rules ?? [],
      publication: PUBLICATION,
    },
    flags: tagFlags(desired.entryId, desired.hash),
  };
}

/* ------------------------------------------------------------------ */
/* Projection + convergence                                            */
/* ------------------------------------------------------------------ */

/** Project the actor's module-tagged Ansu items. */
export function projectTagged(actor) {
  const out = [];
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, ANSU);
    if (!tag?.entryId) continue;
    out.push({ itemId: item.id, entryId: tag.entryId, contentHash: tag.contentHash });
  }
  return out;
}

/** Is this actor in the active, started combat? */
export function inActiveCombat(actor) {
  const combat = game.combat;
  if (!combat?.started) return false;
  return combat.combatants.some((c) => c.actor === actor || c.actor?.uuid === actor.uuid);
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
    console.error(`${MODULE_ID} | ansu content unavailable, skipping sync`, err);
    return;
  }

  const state = readAnsu(actor);
  const opts = {
    charLevel: charLevelOf(actor),
    dials: readDials(),
    marker: game.settings.get(MODULE_ID, SETTINGS.ANSU_MARKER) !== false,
    now: game.time?.worldTime ?? 0,
  };
  const attuned = isAttuned(actor);
  const attunement = attuned ? composeAttunement(state, content, opts) : null;
  const communion = attuned ? composeCommunion(state, content, opts) : null;
  const feats = attuned ? composeFeats(state, content, opts) : [];
  const actions = attuned ? composeActions(state, content, opts) : [];
  const desired = [...(attunement ? [attunement] : []), ...(communion ? [communion] : []), ...feats, ...actions];
  const { toCreate, toUpdate, toDeleteIds } = diffAll(desired, projectTagged(actor));
  if (!toCreate.length && !toUpdate.length && !toDeleteIds.length) return;

  const inCombat = inActiveCombat(actor);
  const build = (d) => {
    if (d.entryId === ATTUNEMENT_ENTRY_ID) return buildAttunementSource(d);
    if (d.entryId === COMMUNION_ENTRY_ID) return buildCommunionSource(d, { inCombat });
    if (d.kind === "feat") return buildFeatSource(d);
    return buildActionSource(d);
  };

  syncing.add(actor.id);
  try {
    if (toDeleteIds.length) await actor.deleteEmbeddedDocuments("Item", [...new Set(toDeleteIds)]);
    if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate.map(build));
    if (toUpdate.length) {
      const updates = toUpdate.map(({ itemId, desired: d }) => {
        const src = build(d);
        const update = { _id: itemId, name: src.name, img: src.img, system: src.system, flags: src.flags };
        // A content-only update (same mode) must not clobber a running combat
        // countdown; a mode change (active → lingering, → seized) stamps fresh.
        if (d.entryId === COMMUNION_ENTRY_ID) {
          const prevMode = actor.items.get(itemId)?.getFlag?.(MODULE_ID, ANSU)?.mode;
          if (prevMode === d.mode) delete update.system.duration;
        }
        return update;
      });
      await actor.updateEmbeddedDocuments("Item", updates);
    }
  } finally {
    syncing.delete(actor.id);
  }
  warnDroppedRules(actor, attunement, communion);
}

/**
 * Diagnostic: pf2e silently drops rule elements that fail schema validation. After a
 * sync, compare what we composed against what actually applied and name the missing
 * keys, so "something isn't showing" is a console line instead of a mystery.
 */
function warnDroppedRules(actor, ...composedEffects) {
  try {
    for (const composed of composedEffects) {
      if (!composed) continue;
      const item = actor.items.find((i) => i.getFlag?.(MODULE_ID, ANSU)?.entryId === composed.entryId);
      if (!item) continue;
      const applied = (actor.rules ?? []).filter((r) => r.item?.id === item.id && !r.ignored);
      if (applied.length >= composed.rules.length) continue;
      const missing = composed.rules.map((r) => r.key);
      for (const r of applied) {
        const i = missing.indexOf(r.key);
        if (i >= 0) missing.splice(i, 1);
      }
      console.warn(
        `${MODULE_ID} | ${missing.length} rule element(s) on "${actor.name}" (${composed.entryId}) were rejected by pf2e validation: ${missing.join(", ")} — see pf2e's own warning above for the field it disliked.`,
      );
    }
  } catch {
    /* diagnostic only — never break a sync */
  }
}

/** Sync every attuned actor (e.g. after a dial change). Primary GM only. */
export async function syncAllAttuned() {
  if (!isPrimaryGM()) return;
  for (const actor of listAttunedActors()) {
    await syncActor(actor).catch((err) => console.error(`${MODULE_ID} | syncAllAttuned`, err));
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
      syncActor(actor).catch((err) => console.error(`${MODULE_ID} | ansu resync`, err));
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
    const tag = item.getFlag?.(MODULE_ID, ANSU);
    if (!tag?.entryId || !isAttuned(actor)) return;
    scheduleResync(actor);
  });

  // Two-way badge: click-adjusting the counter on the Attunement marker IS a level change.
  Hooks.on("updateItem", (item, changes) => {
    if (!isPrimaryGM()) return;
    const actor = item.parent;
    if (!actor || syncing.has(actor.id)) return;
    const tag = item.getFlag?.(MODULE_ID, ANSU);
    if (tag?.entryId !== ATTUNEMENT_ENTRY_ID || !isAttuned(actor)) return;
    const badge = changes?.system?.badge?.value;
    if (badge === undefined || badge === null) return;
    const st = readAnsu(actor);
    if (st.terminal) {
      scheduleResync(actor); // terminal badge is fixed — snap it back
      return;
    }
    const next = clampLevel(Math.min(badge, MAX_LEVEL - 1));
    if (next === st.level) return;
    Promise.resolve(onLevelFromBadge?.(actor, st.level, next)).catch((err) =>
      console.error(`${MODULE_ID} | ansu badge level change`, err),
    );
  });

  // Character level-up: baked DC/temp-HP numbers must be recomputed.
  Hooks.on("updateActor", (actor, changes) => {
    if (!isPrimaryGM()) return;
    if (syncing.has(actor.id) || !isAttuned(actor)) return;
    if (changes?.system?.details?.level?.value === undefined) return;
    scheduleResync(actor);
  });
}

/** Tier id for display, terminal-aware (shared by panel + others). */
export function displayTier(state) {
  if (state.terminal === "subjugated") return "subjugated";
  if (state.terminal === "taken") return "taken";
  return tierForLevel(state.level).id;
}
