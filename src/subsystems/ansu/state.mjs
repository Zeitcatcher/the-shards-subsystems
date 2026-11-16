/**
 * Ansu per-actor flag state: schema defaults, a defensive reader that heals
 * missing keys, and the small mutation helpers every caller routes through.
 *
 * All data lives under a single namespaced object: flags[MODULE_ID].ansu —
 * fully independent of the Izir namespace, so one actor can carry both tracks.
 */

import { MODULE_ID, ANSU } from "../../core/constants.mjs";
import {
  readSubsystemFlag,
  patchSubsystemFlag,
  deleteSubsystemFlag,
  withFlagLock,
  logEntries,
  appendEntries,
  mergePatch,
} from "../../core/flags.mjs";
import { MURKHOR_TRAIT } from "./traits.mjs";
import { LOYALTY_DEFAULT, clampLoyalty, clampWrath } from "./logic/model.mjs";

/** Add or remove the pf2e "murkhor" creature trait, keeping it in sync with attunement. */
async function setMurkhorTrait(actor, on) {
  // pf2e characters rebuild system.traits from scratch every data prep, so a
  // source write is both a no-op AND persists junk (the prepared ancestry traits)
  // into character source. Only NPC-type actors keep a written creature trait; a
  // PC that needs the tag gets it from the registered homebrew trait selector. (C4)
  if (actor?.type === "character") return;
  // Read from _source, not the prepared data: on an NPC the prepared list also
  // holds traits rule elements added this data-prep pass, and writing it back
  // bakes them into source for good. (Izir F15, ported in 0.8.0)
  const traits = actor?._source?.system?.traits?.value ?? actor?.system?.traits?.value;
  if (!Array.isArray(traits)) return;
  const has = traits.includes(MURKHOR_TRAIT);
  if (on && !has) {
    await actor.update({ "system.traits.value": [...traits, MURKHOR_TRAIT] });
  } else if (!on && has) {
    await actor.update({ "system.traits.value": traits.filter((t) => t !== MURKHOR_TRAIT) });
  }
}

/** A fresh, fully-defaulted state object (level 0, attuned, dormant). */
export function emptyAnsuState() {
  return {
    v: 1,
    enabled: true,
    level: 0,
    climb: 0, // the retired Climb (0.7): kept readable, unused since rework step E
    loyalty: LOYALTY_DEFAULT, // 0..10, rework 0.8
    wrath: 0, // 0..6, rework 0.8
    lockout: null, // null | { until: worldTime|null, untilRest: boolean }
    consentUsed: false, // reset by a night's rest
    terminal: null, // null | "subjugated" (Mastery) | "taken" (the Ansu wins)
    suppressed: [], // [{ id: <family>, reason: string, at: ts }]
    communion: {
      mode: "none", // "none" | "active" | "seized" ("lingering" is healed to "none" on read since 0.8)
      rounds: null, // stamped duration at invoke (display only)
      startAt: null, // one-shot world-time stamp for the next countdown (seizure return); consumed by the sync
      returnPenalty: 0, // 0 | 2, added to the next release DC
    },
    pendingRelease: null, // { id, dc, reason, createdAt }
    pendingCall: null, // { id, dc, createdAt } — the Athletics gate on Invoke
    // The last resolved roll of each kind, and a reroll of it waiting on the GM.
    // A hero point deletes the rolled card and posts a fresh one; the pending
    // marker is long gone by then, so the recorded outcome is what a reroll is
    // compared against. Nothing auto-applies. (0.6.6)
    lastRelease: null, // { id, dc, outcome, at }
    lastCall: null, // { id, dc, outcome, at }
    rerollRelease: null, // { id, from, outcome, total, at }
    rerollCall: null, // { id, from, outcome, total, at }
    // The conflict of will (0.8): the open card (stage persuade | will | berserk),
    // the last resolved check and a reroll of it waiting on the GM.
    pendingConflict: null, // { id, dc, stage, want, severity, createdAt }
    lastConflict: null, // { id, dc, stage, outcome, wrath, want, at }
    rerollConflict: null, // { id, stage, from, outcome, total, at }
    seizure: null, // { snapshot, at, kind: "forced"|"agreed"|"berserk"|"manual", auto, turnsLeft, skipTurnEnd, deed, dc, conflictId, startRound }
    cooldowns: [], // [{ id: <entryId>, until: worldTime }] — module-owned ability cooldowns (array: replaced wholesale on patch)
    art: {
      thresholds: {
        4: { portrait: "", token: "" },
        7: { portrait: "", token: "" },
        10: { portrait: "", token: "" },
      },
      original: null, // { portrait, token } captured before the first swap
      applied: null, // "4" | "7" | "10" | null
    },
    log: [], // [{ t, type, data, note }]
    journalId: null,
    valuesJournalId: null, // the bearer's "What the Ansu values" page (0.8)
  };
}

/**
 * Deep-merge a raw flag over the defaults so old/partial data gains new keys.
 * Arrays and primitives are taken from `raw` when present; nested plain objects
 * recurse. Pure — unit-tested.
 */
export function healDefaults(raw) {
  return healRework(merge(emptyAnsuState(), raw));
}

/**
 * Rework 0.8 read-time healing: clamp loyalty 0..10 and wrath 0..6 (bad values
 * fall back to 5 / 0), returnPenalty to 0 or 2, a malformed lockout to null,
 * consentUsed to a boolean. No conversion from the Climb. Pure.
 */
function healRework(st) {
  st.loyalty = clampLoyalty(st.loyalty);
  st.wrath = clampWrath(st.wrath);
  st.consentUsed = st.consentUsed === true;
  if (st.communion && typeof st.communion === "object") {
    st.communion.returnPenalty = Number(st.communion.returnPenalty) === 2 ? 2 : 0;
    // Lingering is unreachable from 0.8 (step C): no release outcome leads into
    // it. A stored one (an old world, or a seizure landing) reads as dormant.
    if (st.communion.mode === "lingering") {
      st.communion.mode = "none";
      st.communion.rounds = null;
      st.communion.startAt = null;
    }
  }
  const lo = st.lockout;
  if (!lo || typeof lo !== "object" || Array.isArray(lo)) {
    st.lockout = null;
  } else {
    const until = Number.isFinite(Number(lo.until)) && lo.until !== null ? Number(lo.until) : null;
    const untilRest = lo.untilRest === true;
    st.lockout = until === null && !untilRest ? null : { until, untilRest };
  }
  return st;
}

function merge(def, raw) {
  if (raw === undefined || raw === null || typeof raw !== "object") return def;
  const out = Array.isArray(def) ? [...def] : { ...def };
  for (const k of Object.keys(def)) {
    const dv = def[k];
    const rv = raw[k];
    if (rv === undefined) continue;
    if (dv && typeof dv === "object" && !Array.isArray(dv) && rv && typeof rv === "object" && !Array.isArray(rv)) {
      out[k] = merge(dv, rv);
    } else {
      out[k] = rv;
    }
  }
  return out;
}

/** Read a fully-healed Ansu state for an actor (defaults if untracked). */
export function readAnsu(actor) {
  return healDefaults(readSubsystemFlag(actor, ANSU));
}

/** Is this actor a tracked Ansu-bearer? (flag present and not being torn down). */
export function isAttuned(actor) {
  const raw = readSubsystemFlag(actor, ANSU);
  return Boolean(raw) && raw.enabled !== false;
}

/**
 * All attuned actors: world actors AND token actors placed on any scene (unlinked
 * NPC tokens are synthetic actors that never appear in game.actors). Deduped by UUID.
 */
export function listAttunedActors() {
  const byUuid = new Map();
  for (const a of game.actors?.contents ?? []) {
    if (isAttuned(a)) byUuid.set(a.uuid, a);
  }
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens ?? []) {
      const a = token.actor;
      if (a && isAttuned(a)) byUuid.set(a.uuid, a);
    }
  }
  return [...byUuid.values()];
}

/** Attune an actor (creates the flag at level 0, applies the murkhor trait). */
export async function attuneActor(actor) {
  await actor.setFlag(MODULE_ID, ANSU, emptyAnsuState());
  await setMurkhorTrait(actor, true);
}

/** Remove the Ansu flag namespace and the trait (callers strip items first). */
export async function unattuneActor(actor) {
  await setMurkhorTrait(actor, false);
  await deleteSubsystemFlag(actor, ANSU);
}

/**
 * Apply a nested patch to the actor's Ansu state (arrays replaced wholesale).
 *
 * `log` (one entry `{type, data, note}` or a list) is appended to the history
 * inside the same update, read fresh under the flag lock, so a step and its
 * history rows cost one write. `update` adds other dot-path fields of the actor
 * (Hit Points) to that same write. (0.8.0)
 */
export async function patchAnsu(actor, patch, { log, update } = {}) {
  const entries = logEntries(log);
  if (!entries.length) return patchSubsystemFlag(actor, ANSU, patch, update);
  return withFlagLock(actor, () => writeWithLog(actor, readAnsu(actor), patch, entries, update));
}

/**
 * Read-modify-write under the flag lock: `fn(state)` returns `{patch, log,
 * update, result}` (or null to write nothing) and runs on the state as it is
 * once every earlier write of this actor has landed. Returns `result`.
 */
export async function mutateAnsu(actor, fn) {
  return withFlagLock(actor, async () => {
    const st = readAnsu(actor);
    const out = fn(st);
    if (!out) return null;
    await writeWithLog(actor, st, out.patch ?? {}, logEntries(out.log), out.update);
    return out.result;
  });
}

function writeWithLog(actor, st, patch, entries, update) {
  if (entries.length) {
    const base = Array.isArray(patch.log) ? patch.log : st.log;
    patch = { ...patch, log: appendEntries(base, entries, LOG_CAP) };
  }
  return patchSubsystemFlag(actor, ANSU, patch, update);
}

/** One history row, in the shape appendLog has always written. */
export const logEntry = (type, data = {}, note = "") => ({ type, data, note });

/** Newest-N cap on the history log so a long campaign can't grow it without bound. */
const LOG_CAP = 300;

/** Append one entry to the history log (capped to the newest LOG_CAP). GM-side only. */
export async function appendLog(actor, type, data = {}, note = "") {
  await patchAnsu(actor, {}, { log: logEntry(type, data, note) });
}

/**
 * A caller's pending write (`{patch, log, update}`) folded into the next one, so
 * an outcome and the state change it causes land in one update. `extra` comes
 * first: its log rows precede `log`. Pure.
 */
export function withExtra(extra, patch, log = []) {
  return {
    patch: mergePatch(extra?.patch ?? {}, patch),
    log: [...logEntries(extra?.log), ...logEntries(log)],
    update: extra?.update ? { ...extra.update } : undefined,
  };
}

/** Write a caller's pending `{patch, log, update}` on its own (a step that ends early). */
export async function flushExtra(actor, extra) {
  if (!extra) return;
  const entries = logEntries(extra.log);
  const hasPatch = extra.patch && Object.keys(extra.patch).length > 0;
  const hasUpdate = extra.update && Object.keys(extra.update).length > 0;
  if (!hasPatch && !entries.length && !hasUpdate) return;
  await patchAnsu(actor, extra.patch ?? {}, { log: entries, update: extra.update });
}
