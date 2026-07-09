/**
 * Izir per-actor flag state: the schema defaults, a defensive reader that heals
 * missing keys, and the small mutation helpers every caller routes through.
 *
 * All data lives under a single namespaced object: flags[MODULE_ID].izir
 */

import { MODULE_ID, IZIR } from "../../core/constants.mjs";
import {
  readSubsystemFlag,
  patchSubsystemFlag,
  deleteSubsystemFlag,
} from "../../core/flags.mjs";
import { NAMELESS_TRAIT } from "./traits.mjs";

/** Add or remove the pf2e "nameless" creature trait, keeping it in sync with marking. */
async function setNamelessTrait(actor, on) {
  // pf2e characters rebuild system.traits from scratch every data prep, so a
  // source write is both a no-op AND persists junk (the prepared ancestry traits)
  // into character source. Only NPC-type actors keep a written creature trait; a
  // PC that needs the tag gets it from the registered homebrew trait selector. (C4)
  if (actor?.type === "character") return;
  const traits = actor.system?.traits?.value;
  if (!Array.isArray(traits)) return;
  const has = traits.includes(NAMELESS_TRAIT);
  if (on && !has) {
    await actor.update({ "system.traits.value": [...traits, NAMELESS_TRAIT] });
  } else if (!on && has) {
    await actor.update({ "system.traits.value": traits.filter((t) => t !== NAMELESS_TRAIT) });
  }
}

/** A fresh, fully-defaulted state object (level 0, marked, nothing suppressed). */
export function emptyIzirState() {
  return {
    v: 2,
    enabled: true,
    level: 0,
    slide: 0, // progress toward the next level (needs 3 × level to rise)
    terminal: null, // null | "nineveh" | "subjugated"
    suppressed: [], // [{ id: <family>, reason: string, at: ts }]  — boons AND banes
    revealed: [], // [<family>] — banes identified to the player
    art: {
      thresholds: {
        4: { portrait: "", token: "" },
        7: { portrait: "", token: "" },
        10: { portrait: "", token: "" },
      },
      original: null, // { portrait, token } captured before the first swap
      applied: null, // "4" | "7" | "10" | null
    },
    pendingTemptation: null, // { id, dc, reason, createdAt }
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
  return merge(emptyIzirState(), raw);
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

/** Read a fully-healed Izir state for an actor (defaults if untracked). */
export function readIzir(actor) {
  return healDefaults(readSubsystemFlag(actor, IZIR));
}

/** Is this actor a tracked Безымянный? (flag present and not being torn down). */
export function isMarked(actor) {
  const raw = readSubsystemFlag(actor, IZIR);
  return Boolean(raw) && raw.enabled !== false;
}

/**
 * All marked actors: world actors AND token actors placed on any scene (unlinked NPC
 * tokens are synthetic actors that never appear in game.actors). Deduped by UUID.
 */
export function listMarkedActors() {
  const byUuid = new Map();
  for (const a of game.actors?.contents ?? []) {
    if (isMarked(a)) byUuid.set(a.uuid, a);
  }
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens ?? []) {
      const a = token.actor;
      if (a && isMarked(a)) byUuid.set(a.uuid, a);
    }
  }
  return [...byUuid.values()];
}

/** Mark an actor as Nameless (creates the flag at level 0, applies the trait). */
export async function markActor(actor) {
  await actor.setFlag(MODULE_ID, IZIR, emptyIzirState());
  await setNamelessTrait(actor, true);
}

/** Remove the Izir flag namespace and the trait (callers strip items first). */
export async function unmarkActor(actor) {
  await setNamelessTrait(actor, false);
  await deleteSubsystemFlag(actor, IZIR);
}

/** Apply a nested patch to the actor's Izir state (arrays replaced wholesale). */
export async function patchIzir(actor, patch) {
  await patchSubsystemFlag(actor, IZIR, patch);
}

/** Newest-N cap on the history log so a long campaign can't grow it without bound. */
const LOG_CAP = 300;

/** Append one entry to the history log (capped to the newest LOG_CAP). GM-side only. */
export async function appendLog(actor, type, data = {}, note = "") {
  const st = readIzir(actor);
  const log = [...st.log, { t: Date.now(), type, data, note }].slice(-LOG_CAP);
  await patchIzir(actor, { log });
}
