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
} from "../../core/flags.mjs";
import { MURKHOR_TRAIT } from "./traits.mjs";

/** Add or remove the pf2e "murkhor" creature trait, keeping it in sync with attunement. */
async function setMurkhorTrait(actor, on) {
  const traits = actor.system?.traits?.value;
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
    climb: 0, // progress toward the next level (needs 2 + level to rise)
    terminal: null, // null | "subjugated" (Mastery) | "taken" (the Ansu wins)
    suppressed: [], // [{ id: <family>, reason: string, at: ts }]
    communion: {
      mode: "none", // "none" | "active" | "lingering" | "seized"
      rounds: null, // stamped duration at invoke (display only)
    },
    pendingRelease: null, // { id, dc, reason, createdAt }
    pendingCall: null, // { id, dc, createdAt } — the Intimidation gate on Invoke
    seizure: null, // { snapshot, at, auto, returnAt: { combatId, round, turn } }
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
  };
}

/**
 * Deep-merge a raw flag over the defaults so old/partial data gains new keys.
 * Arrays and primitives are taken from `raw` when present; nested plain objects
 * recurse. Pure — unit-tested.
 */
export function healDefaults(raw) {
  return merge(emptyAnsuState(), raw);
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

/** Apply a nested patch to the actor's Ansu state (arrays replaced wholesale). */
export async function patchAnsu(actor, patch) {
  await patchSubsystemFlag(actor, ANSU, patch);
}

/** Append one entry to the append-only history log. GM-side only. */
export async function appendLog(actor, type, data = {}, note = "") {
  const st = readAnsu(actor);
  const log = [...st.log, { t: Date.now(), type, data, note }];
  await patchAnsu(actor, { log });
}
