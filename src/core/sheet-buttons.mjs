/**
 * Best-effort GM launch button injected into pf2e actor sheets. pf2e v8 sheets are
 * ApplicationV2 (some Svelte-rendered) and may shift between minors, so injection is
 * defensive and idempotent — if the DOM differs it silently no-ops and the toolbar
 * button + macro remain the dependable launchers.
 */

import { MODULE_ID } from "./constants.mjs";
import { getSubsystems } from "./subsystems.mjs";

export function registerSheetButtons() {
  const inject = (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? app?.element);
    if (!root) return;
    for (const sub of getSubsystems()) {
      if (typeof sub.sheetButton !== "function") continue;
      try {
        sub.sheetButton(app, root);
      } catch (err) {
        console.warn(`${MODULE_ID} | sheet button (${sub.id})`, err);
      }
    }
  };
  Hooks.on("renderCharacterSheetPF2e", inject);
  Hooks.on("renderNPCSheetPF2e", inject);
}
