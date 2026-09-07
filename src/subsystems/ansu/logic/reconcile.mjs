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

/**
 * Which attunement a ladder row's numbers belong to.
 *
 * The panel built ONE injection context at the bearer's own level and reused it
 * for every row, so an attunement 1 bearer's Discipline rows read "resistance 1"
 * and "resist 2 vs one hit" for boons that only exist from 5, where the real
 * numbers are 3 and 10. Taking the maximum previews a locked row at its unlock
 * level while an unlocked row still shows the bearer's live numbers. (0.6.6)
 */
export function ladderCtxLevel({ rowLevel, level } = {}) {
  const row = Math.max(1, Math.trunc(Number(rowLevel)) || 1);
  const cur = Math.max(1, Math.trunc(Number(level)) || 1);
  return Math.max(row, cur);
}

/**
 * The action-cost glyph for an action-form entry.
 *
 * One helper for the ladder chip and the Communion effect's ability list: they
 * were written twice, both knew only counts and free actions, and the two
 * reactions (Salbarine Parry, The Ansu Refuses) therefore read as passive boons
 * next to "Maker's Wrath ◆◆". (0.6.6)
 */
export function costGlyph(actionData) {
  const n = Math.trunc(Number(actionData?.actions));
  if (Number.isFinite(n) && n > 0 && n <= 3) return "◆".repeat(n);
  if (actionData?.actionType === "free") return "◇";
  if (actionData?.actionType === "reaction") return "↺";
  return "";
}

/**
 * The action block an entry uses in a given state.
 *
 * Mastery's capstone promises entering and leaving Communion as a free action,
 * and Release was already authored that way, but the Invoke item copied its
 * `actionData` verbatim at every state, so a subjugated master's sheet still
 * showed the 1-action, concentrate Invoke the capstone had just replaced. Only
 * "subjugated" reads the override: Taken drops both doors outright (doorsDead),
 * and no other state changes an action's cost. (0.6.6)
 */
export function actionDataFor(entry, state) {
  if (state?.terminal === "subjugated" && entry?.terminalActionData) return entry.terminalActionData;
  return entry?.actionData ?? {};
}

/**
 * The frequency tag beside an ability's name.
 *
 * `frequency.per` is an ISO duration for anything finer than a day ("PT10M" on
 * The Ansu Refuses), and hand-rolling a parser for one value is not worth it:
 * the validator already requires a `cooldownMinutes` alongside such a frequency,
 * and minutes are what the table asks about anyway. (0.6.6)
 */
export function frequencyTag(actionData) {
  if (actionData?.perCommunion) return "1/communion";
  if (actionData?.frequency?.per === "day") return "1/day";
  const mins = Math.trunc(Number(actionData?.cooldownMinutes));
  if (Number.isFinite(mins) && mins > 0) return `1 / ${mins} min`;
  return "";
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
/* Rebuild: the expiry that deletes and re-creates the Communion effect */
/* ------------------------------------------------------------------ */

/**
 * Rule elements that hand something out the moment their item is CREATED.
 *
 * With pf2e's `automation.removeEffects` on, an expiry is a delete followed by
 * our own re-create, so pf2e runs every rule's `onCreate` again and the buff
 * running out handed the bearer a second full pool of temporary Hit Points. With
 * the automation off the same transition is an in-place update and grants
 * nothing — one pf2e setting changed the rules.
 *
 * TempHP is the only create-time granting rule element in the Ansu content
 * today: the single GrantItem is `inMemoryOnly` (it materializes nothing), and
 * FlatModifier / Resistance / DamageDice / RollOption / Note / Strike are all
 * data-prep synthetics. Anything added later that writes on create belongs here.
 */
const CREATE_TIME_GRANT_KEYS = new Set(["TempHP"]);

/**
 * Turn off the create-time grants on a rebuilt item's rules.
 *
 * The rules stay ON the item — pf2e's `onDelete` ignores `events` and still
 * clears the pool when Communion finally ends, and `events` lands inside the
 * composed hash, so the next ordinary sync flips them back with one harmless
 * item update. What is LEFT of the live pool is carried across the delete
 * Foundry-side (see sync.mjs). Pure.
 */
export function suppressCreateGrants(rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.some((r) => CREATE_TIME_GRANT_KEYS.has(r?.key))) return list;
  return list.map((r) =>
    CREATE_TIME_GRANT_KEYS.has(r?.key) ? { ...r, events: { onCreate: false, onTurnStart: false } } : r,
  );
}

/**
 * How much of the live temporary Hit Point pool a deleted item is carrying away.
 * Only ever OUR pool: pf2e records the granting item in `hp.tempsource`, and a
 * pool some other effect handed out must be left where it is.
 */
export function carriedTempFor({ temp, tempsource, itemId } = {}) {
  if (!itemId || tempsource !== itemId) return 0;
  const n = Number(temp);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * What to write back after a rebuild, or null for "leave the actor alone".
 *
 * Temporary Hit Points do not stack in PF2e — the higher grant wins — so a
 * bigger pool that landed from anywhere else meanwhile is never overwritten, and
 * a fully spent pool is never resurrected. This mirrors TempHP's own
 * `value > currentTempHP` guard, which is the rule the fix must not break.
 */
export function tempRestoreValue({ carried, live } = {}) {
  const c = Number(carried);
  const l = Number(live) || 0;
  if (!Number.isFinite(c) || c <= 0) return null;
  return c > l ? Math.trunc(c) : null;
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

/**
 * Are the two door actions (Invoke, Release) dead in this state?
 *
 * At the Taken terminal the Ansu owns the body: `requestInvoke` returns on
 * `terminal === "taken"` and `callRelease` on any terminal, both in silence,
 * while pf2e still spends the 1/round frequency on the Use. The panel already
 * hides both controls; the sheet items had no business being there either.
 * Exported so the panel's ladder can strike the same two chips out rather than
 * offering doors the sheet no longer has. (0.6.6)
 */
export const doorsDead = (mode) => mode === "taken";

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
  // releaseDc is hashed because the marker's DESCRIPTION quotes it: none of the
  // other hashed fields move when a DC dial does, so the syncAllAttuned fired by
  // the settings onChange found no drift and the sheet went on quoting the old
  // number next to action items that had already refreshed. durationRounds needs
  // no seat — it is a pure function of `level`, which is hashed. (0.6.6)
  composed.hash = hashString(
    stableStringify({ level, tier, terminal, rules, inheritanceLines, releaseDc: ctx.releaseDc }),
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
  const dead = doorsDead(mode);
  const { live } = selectEntries(state, content, { ...opts, unlockAll });
  for (const e of live) {
    if (e.always || e.form === "feat") continue;
    // A Taken bearer's Communion effect must not advertise doors that are gone.
    if (dead && e.door === true) continue;
    if (e.form === "effect" || e.form === "strike") {
      rules.push(...deepInject(Array.isArray(e.rules) ? e.rules : [], ctx));
      if (e.form === "strike") rules.push(strikeRuleFor(e));
      boonLines.push({ name: e.name, description: injectNumbers(e.description ?? "", ctx) });
    } else if (e.form === "action") {
      // Same source block composeActions writes onto the sheet, so the effect's
      // ability list and the item itself can't quote two different costs.
      const a = actionDataFor(e, state);
      abilityLines.push({ name: e.name, glyph: costGlyph(a), tag: frequencyTag(a) });
    }
  }

  const permanent = mode === "permanent" || mode === "taken";
  // A rebuild is the SAME Communion continuing, not a new one: pf2e deleted the
  // expired effect and the sync re-creates it, so a create-time grant would fire
  // a second time at the exact moment the buff was supposed to run out. (0.6.6)
  const composedRules = opts.rebuild === true ? suppressCreateGrants(rules) : rules;
  const composed = {
    entryId: COMMUNION_ENTRY_ID,
    kind: "composed-communion",
    level,
    mode,
    permanent,
    durationRounds: permanent ? null : ctx.durationRounds,
    rules: composedRules,
    boonLines,
    abilityLines,
    releaseDc: ctx.releaseDc,
    // Where the next countdown must start, when the state carries a one-shot
    // stamp (the seizure return's turn-end compensation). Deliberately OUT of the
    // hash below: it is a clock instruction consumed by one sync, not content.
    startAt: Number.isFinite(state.communion?.startAt) ? state.communion.startAt : null,
    ctx,
  };
  composed.hash = hashString(
    stableStringify({ level, mode, rules: composedRules, boonLines, abilityLines }),
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

  const dead = doorsDead(mode);
  const { live } = selectEntries(state, content, { ...opts, unlockAll });
  return live
    .filter((e) => e.form === "action")
    .filter((e) => running || e.actionData?.alwaysAvailable === true)
    // diffAll turns the drop into a delete, so an existing sheet cleans itself.
    .filter((e) => !(dead && e.door === true))
    .map((e) => {
      const description = injectNumbers(e.description ?? "", ctx);
      // A subjugated master's Invoke reads from terminalActionData; everyone else
      // from actionData. Every frequency read below uses the same block.
      const src = actionDataFor(e, state);
      const actionData = deepInject(src, ctx);
      // Action items carry their entry's rule elements too (Maker's Wrath /
      // Fair Battle toggle-damage), with number tokens baked like everywhere else.
      const rules = deepInject(Array.isArray(e.rules) ? e.rules : [], ctx);
      if (Number.isInteger(src.cooldownMinutes)) {
        const until = Number((state.cooldowns ?? []).find((c) => c?.id === e.id)?.until) || 0;
        const onCooldown = Number.isFinite(opts.now) && opts.now < until;
        actionData.frequencyValue = onCooldown ? 0 : (src.frequency?.max ?? null);
      } else if (src.alwaysAvailable && src.frequency && !running) {
        // The door must reopen between fights: per-round frequencies only tick
        // inside combat, so a spent Invoke would stay greyed out of combat.
        // Every dormant resync restores its uses.
        actionData.frequencyValue = src.frequency.max ?? null;
      }
      const data = { entryId: e.id, family: e.family, name: e.name, img: e.img, description, actionData, rules, entry: e };
      return { ...data, hash: hashString(stableStringify({ name: e.name, img: e.img, description, actionData, rules })) };
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

  const toCreate = [];
  const toUpdate = [];
  const toDeleteIds = [];
  const matched = new Set();

  // Walk the actor's tagged items once. An item whose entryId isn't desired — or a
  // surplus DUPLICATE of an already-matched entryId (left by a concurrent-sync
  // slip) — is deleted; the first match of each entryId updates on hash drift. The
  // old Map-by-entryId collapsed duplicates and could never remove them. (C1)
  for (const t of tagged) {
    const d = desiredById.get(t.entryId);
    if (!d || matched.has(t.entryId)) {
      toDeleteIds.push(t.itemId);
      continue;
    }
    matched.add(t.entryId);
    if (t.contentHash !== d.hash) toUpdate.push({ itemId: t.itemId, desired: d });
  }
  for (const d of desired) {
    if (!matched.has(d.entryId)) toCreate.push(d);
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
