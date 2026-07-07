/**
 * Pure composition core for Ansu. No Foundry imports — fully vitest-covered.
 *
 * Unlike Izir's single composed effect, Ansu carries up to TWO:
 *  - "Ansu — Attunement" (persistent): the marker with the two-way level badge and
 *    the thin always-on Inheritance line (knowledge stays even while dormant).
 *  - "Ansu — Communion" (stateful): every other boon, present only while Communion
 *    runs (active / lingering / seized / permanent at the terminals).
 * Action-form actives are separate sheet items, same as Izir.
 *
 * `diffAll` mirrors Izir's: desired set vs tagged items → minimal create/update/
 * delete ops, updates in place.
 */

import { clampLevel, tierForLevel, releaseDC, callDC, durationRounds, tempHpFor, resistFor, parryFor, tierDiceFor, MAX_LEVEL } from "./model.mjs";

export const ATTUNEMENT_ENTRY_ID = "ansu-attunement";
export const COMMUNION_ENTRY_ID = "ansu-communion";

/* ------------------------------------------------------------------ */
/* Entry selection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which content entries are live for this state: unlocked by level (or gate),
 * highest rank per family, not suppressed. `opts.unlockAll` (seizure / Taken)
 * unlocks every level AND the gate — the Ansu wields its whole self.
 * Returns { live, replacedIds }.
 */
export function selectEntries(state, content, opts = {}) {
  const unlockAll = Boolean(opts.unlockAll);
  const gateOpen = unlockAll || state.terminal === "subjugated" || state.terminal === "taken";
  const level = unlockAll ? MAX_LEVEL : clampLevel(state.level);
  const suppressed = new Set((state.suppressed ?? []).map((s) => s.id));

  const unlocked = (content?.entries ?? []).filter((e) => {
    if (e.gate === "subjugated") return gateOpen;
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

/** The injection context for a (character level, attunement) pair. */
export function buildCtx(charLevel, level, dials = {}) {
  const cl = Math.max(1, Math.trunc(charLevel) || 1);
  const l = clampLevel(level);
  return {
    charLevel: cl,
    level: l,
    releaseDc: releaseDC(l, dials.dcBase, dials.dcStep, dials.dcCap),
    callDc: callDC(l, dials.callBase, dials.callStep),
    tempHp: tempHpFor(l),
    resist: resistFor(l),
    parry: parryFor(l),
    tierDice: tierDiceFor(l),
    durationRounds: durationRounds(l),
  };
}

/** Human duration text for descriptions ("1 round" / "3 rounds" / "1 minute" / "unlimited"). */
export function durationLabel(rounds) {
  if (rounds === null) return "unlimited";
  if (rounds === 0) return "—";
  if (rounds === 1) return "1 round";
  if (rounds === 10) return "1 minute";
  return `${rounds} rounds`;
}

/** Replace every {{ansu*}} number token with the baked value. */
export function injectNumbers(text, ctx) {
  if (typeof text !== "string") return text;
  return text
    .replaceAll("{{ansuReleaseDC}}", String(ctx.releaseDc))
    .replaceAll("{{ansuCallDC}}", String(ctx.callDc))
    .replaceAll("{{ansuTempHp}}", String(ctx.tempHp))
    .replaceAll("{{ansuResist}}", String(ctx.resist))
    .replaceAll("{{ansuParry}}", String(ctx.parry))
    .replaceAll("{{ansuTierDice}}", String(ctx.tierDice))
    .replaceAll("{{ansuLevel}}", String(ctx.level))
    .replaceAll("{{ansuDuration}}", durationLabel(ctx.durationRounds));
}

function deepInject(value, ctx) {
  if (typeof value === "string") {
    const out = injectNumbers(value, ctx);
    // A fully-numeric result becomes a number so schema-typed RE fields stay valid.
    return out !== value && /^-?\d+$/.test(out) ? Number(out) : out;
  }
  if (Array.isArray(value)) return value.map((v) => deepInject(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepInject(v, ctx);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Composed effects                                                    */
/* ------------------------------------------------------------------ */

/**
 * The Strike rule element for a strike-form boon (Horns Reforged), matching the
 * official bestiary shape. No attackModifier: the horns use the actor's own
 * unarmed math — the Ansu rebuilds the weapon, not the arm swinging it.
 */
function strikeRuleFor(entry) {
  const s = entry.strikeData ?? {};
  return {
    key: "Strike",
    slug: `shards-ansu-${entry.id}`,
    label: entry.name,
    img: entry.img,
    group: s.group ?? "brawling",
    traits: s.traits ?? ["unarmed"],
    range: s.range ?? null,
    damage: { base: { damageType: s.damageType ?? "piercing", dice: s.dice ?? 1, die: s.die ?? "d8" } },
  };
}

/** Communion display mode: how the stateful effect is currently justified. */
export function communionMode(state) {
  if (state.terminal === "taken") return "taken";
  if (state.communion?.mode === "seized") return "seized";
  if (state.terminal === "subjugated") return state.communion?.mode === "active" ? "permanent" : "off";
  return state.communion?.mode ?? "none";
}

/**
 * Compose the persistent "Ansu — Attunement" marker: badge (two-way level) and
 * roll options. Inheritance rules live on their own bonus-feat items now — the
 * marker only NAMES them in its description. Null when nothing should exist
 * (unmarked / level 0 without a terminal / the marker world-setting is off).
 */
export function composeAttunement(state, content, opts = {}) {
  if (state.enabled === false) return null;
  if (opts.marker === false) return null;
  const level = clampLevel(state.level);
  const terminal = state.terminal ?? null;
  if (level < 1 && !terminal) return null;

  const ctx = buildCtx(opts.charLevel, level, opts.dials);
  const tier = terminal ?? tierForLevel(level).id;

  const rules = [
    { key: "RollOption", domain: "all", option: "self:shards:ansu" },
    { key: "RollOption", domain: "all", option: `self:shards:ansu:level:${level}` },
    { key: "RollOption", domain: "all", option: `self:shards:ansu:tier:${tier}` },
  ];

  const inheritanceLines = [];
  const { live } = selectEntries(state, content, opts);
  for (const e of live) {
    if (e.form !== "feat") continue;
    inheritanceLines.push({ name: e.name, description: "" });
  }

  const composed = {
    entryId: ATTUNEMENT_ENTRY_ID,
    kind: "composed-attunement",
    level,
    tier,
    terminal,
    badge: { value: Math.max(1, Math.min(level, MAX_LEVEL)), max: terminal ? MAX_LEVEL : MAX_LEVEL - 1 },
    rules,
    inheritanceLines,
    releaseDc: ctx.releaseDc,
    durationRounds: ctx.durationRounds,
    ctx,
  };
  composed.hash = hashString(
    stableStringify({ level, tier, terminal, rules, inheritanceLines }),
  );
  return composed;
}

/**
 * Compose the stateful "Ansu — Communion" effect. Null while dormant. Carries
 * every non-Inheritance boon rule (seizure / Taken compose at full strength).
 * The item's actual duration is decided Foundry-side (combat vs not); this only
 * reports the tier's round count.
 */
export function composeCommunion(state, content, opts = {}) {
  if (state.enabled === false) return null;
  const mode = communionMode(state);
  if (mode === "none" || mode === "off") return null;

  const unlockAll = mode === "seized" || mode === "taken";
  const level = unlockAll ? MAX_LEVEL : clampLevel(state.level);
  if (level < 1) return null;

  const ctx = buildCtx(opts.charLevel, level, opts.dials);
  const rules = [
    { key: "RollOption", domain: "all", option: "self:shards:ansu:communion" },
    { key: "RollOption", domain: "all", option: `self:shards:ansu:communion:${mode}` },
  ];

  const boonLines = [];
  const abilityLines = [];
  const { live } = selectEntries(state, content, { ...opts, unlockAll });
  for (const e of live) {
    if (e.always || e.form === "feat") continue;
    if (e.form === "effect" || e.form === "strike") {
      rules.push(...deepInject(Array.isArray(e.rules) ? e.rules : [], ctx));
      if (e.form === "strike") rules.push(strikeRuleFor(e));
      boonLines.push({ name: e.name, description: injectNumbers(e.description ?? "", ctx) });
    } else if (e.form === "action") {
      const a = e.actionData ?? {};
      abilityLines.push({
        name: e.name,
        glyph: a.actions ? "◆".repeat(a.actions) : a.actionType === "free" ? "◇" : "",
        tag: a.perCommunion ? "1/communion" : a.frequency?.per === "day" ? "1/day" : "",
      });
    }
  }

  const permanent = mode === "permanent" || mode === "taken";
  const composed = {
    entryId: COMMUNION_ENTRY_ID,
    kind: "composed-communion",
    level,
    mode,
    permanent,
    durationRounds: permanent ? null : ctx.durationRounds,
    rules,
    boonLines,
    abilityLines,
    releaseDc: ctx.releaseDc,
    ctx,
  };
  composed.hash = hashString(
    stableStringify({ level, mode, rules, boonLines, abilityLines }),
  );
  return composed;
}

/* ------------------------------------------------------------------ */
/* Desired feat items (Inheritance — permanent knowledge)              */
/* ------------------------------------------------------------------ */

/**
 * Feat-form entries become bonus feats in the Feats tab: permanent once their
 * level unlocks, independent of Communion — knowledge stays while the power
 * sleeps.
 */
export function composeFeats(state, content, opts = {}) {
  if (state.enabled === false) return [];
  const mode = communionMode(state);
  const unlockAll = mode === "seized" || mode === "taken";
  const level = unlockAll ? MAX_LEVEL : clampLevel(state.level);
  if (level < 1 && !state.terminal) return [];

  const ctx = buildCtx(opts.charLevel, level, opts.dials);
  const { live } = selectEntries(state, content, { ...opts, unlockAll });
  return live
    .filter((e) => e.form === "feat")
    .map((e) => {
      const description = injectNumbers(e.description ?? "", ctx);
      const rules = deepInject(Array.isArray(e.rules) ? e.rules : [], ctx);
      const data = { entryId: e.id, family: e.family, kind: "feat", name: e.name, img: e.img, description, rules, level: e.level, entry: e };
      return { ...data, hash: hashString(stableStringify({ name: e.name, img: e.img, description, rules, level: e.level })) };
    });
}

/* ------------------------------------------------------------------ */
/* Desired action items                                                */
/* ------------------------------------------------------------------ */

/**
 * Action-form actives materialize ONLY while Communion runs; the sole exception
 * is `alwaysAvailable` (Invoke the Ansu — the door in). Entries with
 * `cooldownMinutes` get their frequency uses zeroed while the module-owned
 * world-time cooldown (state.cooldowns[entryId] = until) is running.
 */
export function composeActions(state, content, opts = {}) {
  if (state.enabled === false) return [];
  const mode = communionMode(state);
  const running = mode !== "none" && mode !== "off";
  const unlockAll = mode === "seized" || mode === "taken";
  const level = unlockAll ? MAX_LEVEL : clampLevel(state.level);
  if (level < 1 && !state.terminal) return [];

  const ctx = buildCtx(opts.charLevel, level, opts.dials);

  const { live } = selectEntries(state, content, { ...opts, unlockAll });
  return live
    .filter((e) => e.form === "action")
    .filter((e) => running || e.actionData?.alwaysAvailable === true)
    .map((e) => {
      const description = injectNumbers(e.description ?? "", ctx);
      const actionData = deepInject(e.actionData ?? {}, ctx);
      if (Number.isInteger(e.actionData?.cooldownMinutes)) {
        const until = Number((state.cooldowns ?? []).find((c) => c?.id === e.id)?.until) || 0;
        const onCooldown = Number.isFinite(opts.now) && opts.now < until;
        actionData.frequencyValue = onCooldown ? 0 : (e.actionData?.frequency?.max ?? null);
      }
      const data = { entryId: e.id, family: e.family, name: e.name, img: e.img, description, actionData, entry: e };
      return { ...data, hash: hashString(stableStringify({ name: e.name, img: e.img, description, actionData })) };
    });
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

/**
 * Minimal ops to converge the actor.
 * @param {Array} desired  composed effects + actions (nulls filtered by caller)
 * @param {Array} tagged   [{ itemId, entryId, contentHash }]
 * @returns {{toCreate:Array, toUpdate:Array, toDeleteIds:Array}}
 */
export function diffAll(desired, tagged) {
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
/* Hashing (house-standard FNV-1a, duplicated to keep subsystems free   */
/* of cross-imports)                                                    */
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
