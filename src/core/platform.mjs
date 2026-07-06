/**
 * Version / capability shims. The one place that branches on Foundry version or
 * feature availability, so the rest of the module stays version-agnostic.
 */

export const generation = () => game?.release?.generation ?? 0;

export const isPF2e = () => game.system?.id === "pf2e";

/** True only on the single GM responsible for authoritative writes. */
export const isPrimaryGM = () =>
  Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user?.id);
