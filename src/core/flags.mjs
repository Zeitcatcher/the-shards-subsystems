/**
 * Actor-flag helpers shared by every subsystem.
 *
 * `setFlag` with an object value MERGES (stale keys survive) and never deletes.
 * These helpers instead build dot-path `update()` payloads: nested plain objects
 * are flattened to their own paths, while arrays are written whole (replacement
 * semantics — exactly what we want for lists like `suppressed`/`revealed`/`log`).
 */

import { MODULE_ID } from "./constants.mjs";
import { createActorQueue } from "./platform.mjs";

/** Read a subsystem's raw flag object (undefined if the actor isn't tracked). */
export function readSubsystemFlag(actor, sub) {
  try {
    return actor?.getFlag?.(MODULE_ID, sub);
  } catch {
    return undefined;
  }
}

/**
 * Flatten a (possibly nested) patch into Foundry dot-path update entries rooted at
 * `prefix`. Arrays and non-plain values are leaves. Pure — unit-tested.
 */
export function flattenForUpdate(patch, prefix) {
  const out = {};
  walk(patch, prefix, out);
  return out;
}

function walk(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}.${k}`;
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path, out);
    else out[path] = v;
  }
}

/**
 * Apply a nested patch to `flags[MODULE_ID][sub]` via a single dot-path update.
 * `extra` holds further dot-path fields of the same actor (Hit Points, say) that
 * belong to the same step, so the step costs one write instead of two.
 */
export async function patchSubsystemFlag(actor, sub, patch, extra = null) {
  const update = { ...(extra ?? {}), ...flattenForUpdate(patch, `flags.${MODULE_ID}.${sub}`) };
  if (Object.keys(update).length === 0) return;
  await actor.update(update);
}

/**
 * The per-actor flag lock. Every write that reads the flag and writes back
 * something built from it (a log append, a bar step, a list toggle) runs its
 * read and its write inside this lock, so two quick clicks never both read the
 * same starting point and lose one of the writes. It wraps only the read and the
 * one update, never a caller's longer chain, so it cannot be taken twice on one
 * chain.
 */
export const withFlagLock = createActorQueue();

/** Normalize a log argument (one entry, a list, or nothing) to a list. */
export function logEntries(log) {
  if (!log) return [];
  return (Array.isArray(log) ? log : [log]).filter(Boolean);
}

/**
 * Stamp entries `{type, data, note}` with one timestamp and append them to `log`,
 * keeping the newest `cap`. An entry without a `note` key is written without one
 * (the Call and release rows never carried it). Pure.
 */
export function appendEntries(log, entries, cap, t = Date.now()) {
  const rows = entries.map((e) => {
    const row = { t, type: e.type, data: e.data ?? {} };
    if (e.note !== undefined) row.note = e.note;
    return row;
  });
  return [...(Array.isArray(log) ? log : []), ...rows].slice(-cap);
}

/**
 * Remove a subsystem's entire flag namespace from the actor.
 *
 * This used to hand the update payload `foundry.data.operators.ForcedDeletion`
 * itself — the CLASS, not an instance. A class is a Function, not a
 * `DataFieldOperator`, so it was dropped in serialization and the merge did
 * nothing: Remove attunement left the whole namespace behind. `unsetFlag` picks
 * the right deletion mechanism per Foundry version, `MODULE_ID` is a registered
 * package id so the call is legal, and it is a no-op when the key is already
 * gone. The `-=` payload stays as the fallback for anything without the
 * document API. (0.6.6 — shared with Izir's unattune path.)
 */
export async function deleteSubsystemFlag(actor, sub) {
  if (typeof actor?.unsetFlag === "function") {
    await actor.unsetFlag(MODULE_ID, sub);
    return;
  }
  await actor?.update?.({ [`flags.${MODULE_ID}.-=${sub}`]: null });
}

/**
 * Merge two nested patches; `b` wins on a clash, plain objects merge key by key,
 * arrays and other values are replaced. Pure.
 */
export function mergePatch(a = {}, b = {}) {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) {
    const cur = out[k];
    const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
    out[k] = plain(cur) && plain(v) ? mergePatch(cur, v) : v;
  }
  return out;
}
