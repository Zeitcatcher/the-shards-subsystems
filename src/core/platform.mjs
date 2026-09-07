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
