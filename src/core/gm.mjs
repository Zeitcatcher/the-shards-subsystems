/**
 * GM gating for the subsystem dashboards.
 *
 * Both panels are GM tools, but nothing in Foundry enforced that. The scene
 * control is hidden from players, and that was the whole defence: anyone who ran
 * the launcher macro or typed one line in the console got the panel, and Foundry
 * then happily let them drive their OWN actor's track, because they own it.
 *
 * The fix is three gates, not one — the entry point, the render, and every
 * action handler — so a hand-built click can never reach a mutation even if the
 * window is already on screen when a user's GM status changes.
 *
 * Ansu carries its own copy of this shape from 0.6.6; this module is the shared
 * version Izir uses, kept identical so the two can converge later.
 */

/** True for a GM client. Deliberately not `isPrimaryGM` — any GM may drive a panel. */
export const isGM = () => game.user?.isGM === true;

/** Tell the non-GM why nothing happened. */
export function refuseNonGM(messageKey) {
  ui.notifications?.warn(game.i18n.localize(messageKey));
}

/**
 * Wrap an ApplicationV2 action map so every handler checks GM status first.
 * Returns a new map; the originals are untouched.
 */
export function gmGuarded(actions, messageKey) {
  return Object.fromEntries(
    Object.entries(actions).map(([name, handler]) => [
      name,
      function guarded(...args) {
        if (!isGM()) return refuseNonGM(messageKey);
        return handler.apply(this, args);
      },
    ]),
  );
}
