/**
 * Actor-flag helpers shared by every subsystem.
 *
 * `setFlag` with an object value MERGES (stale keys survive) and never deletes.
 * These helpers instead build dot-path `update()` payloads: nested plain objects
 * are flattened to their own paths, while arrays are written whole (replacement
 * semantics — exactly what we want for lists like `suppressed`/`revealed`/`log`).
 */

import { MODULE_ID } from "./constants.mjs";

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

/** Apply a nested patch to `flags[MODULE_ID][sub]` via a single dot-path update. */
export async function patchSubsystemFlag(actor, sub, patch) {
  const update = flattenForUpdate(patch, `flags.${MODULE_ID}.${sub}`);
  if (Object.keys(update).length === 0) return;
  await actor.update(update);
}

/** Remove a subsystem's entire flag namespace from the actor. */
export async function deleteSubsystemFlag(actor, sub) {
  // v14 deprecates the "-=key" deletion syntax in favor of the ForcedDeletion operator.
  const ForcedDeletion = foundry.data?.operators?.ForcedDeletion;
  if (ForcedDeletion) {
    await actor.update({ [`flags.${MODULE_ID}`]: { [sub]: ForcedDeletion } });
  } else {
    await actor.update({ [`flags.${MODULE_ID}.-=${sub}`]: null });
  }
}
