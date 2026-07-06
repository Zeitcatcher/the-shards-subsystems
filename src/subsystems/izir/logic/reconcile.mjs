/**
 * Pure composition core. No Foundry imports — fully vitest-covered.
 *
 * v0.2.0 model: instead of one item per boon/bane, the actor carries ONE composed
 * effect ("Izir — Immersion") holding every active rule element, plus one action
 * item per unlocked active ability. `composeAll` turns (flag state + content +
 * character level) into that desired set; `diffAll` compares it against what is on
 * the actor and returns minimal create/update/delete operations (updates happen
 * in place — no delete-and-recreate churn).
 */

import { clampLevel, tierForLevel, izirAttack, izirDC, MAX_LEVEL } from "./model.mjs";

export const EFFECT_ENTRY_ID = "izir-immersion";
const MASKED_LABEL = "SHARDS.Izir.MaskedLabel";

/* ------------------------------------------------------------------ */
/* Entry selection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which content entries are live for this state: unlocked by level (or gate),
 * highest rank per family, not suppressed.
 * Returns { live, replacedIds } where replacedIds are lower ranks shadowed by a
 * higher unlocked rank (useful for UI).
 */
export function selectEntries(state, content) {
  const subjugated = state.terminal === "subjugated";
  const level = clampLevel(state.level);
  const suppressed = new Set((state.suppressed ?? []).map((s) => s.id));

  const unlocked = (content?.entries ?? []).filter((e) => {
    if (e.gate === "subjugated") return subjugated;
    return e.level <= level;
  });

  const bestByFamily = new Map();
  for (const e of unlocked) {
    const cur = bestByFamily.get(e.family);
    if (!cur || (e.rank ?? 0) > (cur.rank ?? 0)) bestByFamily.set(e.family, e);
  }

  const replacedIds = unlocked.filter((e) => bestByFamily.get(e.family) !== e).map((e) => e.id);
  const live = [...bestByFamily.values()]
    .filter((e) => !suppressed.has(e.family))
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));

  return { live, replacedIds };
}

/* ------------------------------------------------------------------ */
/* Number injection                                                    */
/* ------------------------------------------------------------------ */

/** Replace {{izirDC}} / {{izirAttack}} / {{izirLevel}} tokens in a string. */
export function injectNumbers(text, ctx) {
  if (typeof text !== "string") return text;
  return text
    .replaceAll("{{izirDC}}", String(ctx.dc))
    .replaceAll("{{izirAttack}}", String(ctx.attack))
    .replaceAll("{{izirLevel}}", String(ctx.level));
}

function deepInject(value, ctx) {
  if (typeof value === "string") return injectNumbers(value, ctx);
  if (Array.isArray(value)) return value.map((v) => deepInject(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepInject(v, ctx);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* The composed effect                                                 */
/* ------------------------------------------------------------------ */

function isRevealed(entry, state, opts) {
  if (entry.kind !== "bane") return true;
  return Boolean(opts.transparency) || (state.revealed ?? []).includes(entry.family);
}

/** Rule elements contributed by one entry, with labels masked or unmasked. */
function rulesFor(entry, revealed, ctx) {
  const rules = Array.isArray(entry.rules) ? deepInject(entry.rules, ctx) : [];
  if (entry.kind !== "bane") return rules;
  return rules.map((r) => {
    if (!("label" in r) && !["FlatModifier", "DamageDice"].includes(r.key)) return r;
    return { ...r, label: revealed ? entry.name : MASKED_LABEL };
  });
}

/** The Strike rule element for a strike-form active (fixed Izir attack modifier). */
function strikeRuleFor(entry, ctx) {
  const s = entry.strikeData ?? {};
  const diceNumber = Math.max(1, Math.ceil(ctx.charLevel / 2));
  return {
    key: "Strike",
    slug: `shards-izir-${entry.id}`,
    label: entry.name,
    img: entry.img,
    category: s.category ?? "unarmed",
    group: s.group ?? "brawling",
    traits: s.traits ?? ["magical", "void"],
    range: s.range ?? null,
    attackModifier: ctx.attack,
    damage: { base: { damageType: s.damageType ?? "void", dice: diceNumber, die: s.die ?? "d4" } },
  };
}

/**
 * Compose the single "Izir — Immersion" effect source for a state.
 * Returns null when nothing should exist (unmarked / level 0 without terminal).
 */
export function composeEffect(state, content, opts = {}) {
  const level = clampLevel(state.level);
  if (state.enabled === false) return null;
  const subjugated = state.terminal === "subjugated";
  const consumed = state.terminal === "nineveh";
  if (level < 1 && !subjugated && !consumed) return null;

  const charLevel = Math.max(1, Math.trunc(opts.charLevel) || 1);
  const ctx = { charLevel, level, attack: izirAttack(charLevel, level), dc: izirDC(charLevel, level) };
  const tier = consumed ? "nineveh" : subjugated ? "subjugated" : tierForLevel(level).id;

  const rules = [
    { key: "RollOption", domain: "all", option: "self:shards:izir" },
    { key: "RollOption", domain: "all", option: `self:shards:izir:level:${level}` },
    { key: "RollOption", domain: "all", option: `self:shards:izir:tier:${tier}` },
  ];

  const boonLines = [];
  const priceLines = [];
  let hiddenPrices = 0;

  if (!consumed) {
    const { live } = selectEntries(state, content);
    for (const e of live) {
      const revealed = isRevealed(e, state, opts);
      if (e.form === "effect" || e.form === "strike") {
        rules.push(...rulesFor(e, revealed, ctx));
        if (e.form === "strike") rules.push(strikeRuleFor(e, ctx));
      }
      // action-form entries contribute no rules here — they become sheet items.
      if (e.kind === "boon" && e.form !== "action") {
        boonLines.push({ name: e.name, description: injectNumbers(e.description ?? "", ctx) });
      } else if (e.kind === "bane") {
        if (revealed) priceLines.push({ name: e.name, description: injectNumbers(e.description ?? "", ctx) });
        else hiddenPrices += 1;
      }
    }
  }

  return {
    entryId: EFFECT_ENTRY_ID,
    kind: "composed-effect",
    level,
    tier,
    terminal: state.terminal ?? null,
    badge: { value: Math.max(1, Math.min(level, MAX_LEVEL)), max: consumed || subjugated ? MAX_LEVEL : MAX_LEVEL - 1 },
    rules,
    boonLines,
    priceLines,
    hiddenPrices,
    ctx,
    hash: hashString(
      stableStringify({ level, tier, terminal: state.terminal ?? null, rules, boonLines, priceLines, hiddenPrices }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Desired action items                                                */
/* ------------------------------------------------------------------ */

/** Action-form actives that should exist as sheet items. */
export function composeActions(state, content, opts = {}) {
  if (state.enabled === false || state.terminal === "nineveh") return [];
  const level = clampLevel(state.level);
  if (level < 1 && state.terminal !== "subjugated") return [];

  const charLevel = Math.max(1, Math.trunc(opts.charLevel) || 1);
  const ctx = { charLevel, level, attack: izirAttack(charLevel, level), dc: izirDC(charLevel, level) };

  const { live } = selectEntries(state, content);
  return live
    .filter((e) => e.form === "action")
    .map((e) => {
      const description = injectNumbers(e.description ?? "", ctx);
      const actionData = deepInject(e.actionData ?? {}, ctx);
      const data = { entryId: e.id, family: e.family, name: e.name, img: e.img, description, actionData, entry: e };
      return { ...data, hash: hashString(stableStringify({ name: e.name, img: e.img, description, actionData })) };
    });
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

/**
 * Minimal ops to converge the actor.
 * @param {object|null} desiredEffect   composeEffect result
 * @param {Array} desiredActions        composeActions result
 * @param {Array} tagged                [{ itemId, entryId, contentHash }]
 * @returns {{toCreate:Array, toUpdate:Array, toDeleteIds:Array}}
 */
export function diffAll(desiredEffect, desiredActions, tagged) {
  const desired = [...(desiredEffect ? [desiredEffect] : []), ...desiredActions];
  const desiredById = new Map(desired.map((d) => [d.entryId, d]));
  const taggedById = new Map(tagged.map((t) => [t.entryId, t]));

  const toCreate = [];
  const toUpdate = [];
  const toDeleteIds = [];

  for (const d of desired) {
    const t = taggedById.get(d.entryId);
    if (!t) toCreate.push(d);
    else if (t.contentHash !== d.hash) toUpdate.push({ itemId: t.itemId, desired: d });
  }
  for (const t of tagged) {
    if (!desiredById.has(t.entryId)) toDeleteIds.push(t.itemId);
  }
  return { toCreate, toUpdate, toDeleteIds };
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic JSON with sorted object keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** FNV-1a 32-bit → base36. Short, stable, dependency-free. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
