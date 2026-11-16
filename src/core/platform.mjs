/**
 * Version / capability shims. The one place that branches on Foundry version or
 * feature availability, so the rest of the module stays version-agnostic.
 */

export const generation = () => game?.release?.generation ?? 0;

export const isPF2e = () => game.system?.id === "pf2e";

/** True only on the single GM responsible for authoritative writes. */
export const isPrimaryGM = () =>
  Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user?.id);

/**
 * Stable per-actor key for in-memory guards (sync chains, expiry locks, recording
 * sets). `actor.id` is the BASE actor's id on a synthetic (unlinked token) actor,
 * so two tokens of one statblock share it and one token's guard silently swallows
 * the other's work. The uuid is per-token.
 */
export const actorKey = (actor) => actor?.uuid ?? actor?.id ?? "";

/**
 * A per-actor queue: `run(actor, fn)` starts `fn` only after every earlier call
 * for the same actor has settled, so read-modify-write steps on one actor never
 * overlap. Keyed by uuid (see actorKey). A thrown `fn` rejects its own call and
 * does not wedge the queue. Never call `run` for an actor from inside an `fn`
 * the same queue is running for that actor: the inner call waits on the outer.
 */
export function createActorQueue() {
  const tails = new Map();
  return async function run(actor, fn) {
    const key = actorKey(actor);
    if (!key) return fn();
    const prev = tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/**
 * Trailing debounce: a burst of calls runs `fn` once, `ms` after the last one.
 * Used for panel redraws, where every write of a roll used to redraw the panel.
 */
export function debounce(fn, ms = 50) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
