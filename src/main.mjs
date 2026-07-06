/**
 * The Shards — Campaign Subsystems: umbrella entry point.
 * Wires Foundry hooks to the shared core and to each registered subsystem; holds no
 * game logic itself.
 */

import { MODULE_ID, TEMPLATES } from "./core/constants.mjs";
import { registerAllSettings } from "./core/settings.mjs";
import { registerControls, ensureLauncherMacros } from "./core/controls.mjs";
import { registerSheetButtons } from "./core/sheet-buttons.mjs";
import { getSubsystems, getSubsystem } from "./core/subsystems.mjs";
import { isPrimaryGM } from "./core/platform.mjs";

// Subsystems self-register at import time.
import "./subsystems/izir/index.mjs";

Hooks.once("init", () => {
  Handlebars.registerHelper("shardsEq", (a, b) => a === b);

  registerAllSettings();
  registerControls();
  registerSheetButtons();
  for (const sub of getSubsystems()) sub.onInit?.();

  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    openPanel: (id, actorId) => getSubsystem(id)?.openPanel(actorId),
    subsystems: () => getSubsystems().map((s) => s.id),
  };
  globalThis.TheShardsSubsystems = mod.api;

  console.log(`${MODULE_ID} | initialised`);
});

Hooks.once("setup", async () => {
  await foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES));
});

Hooks.once("ready", async () => {
  // Only the primary GM creates world documents (macros), so a second GM logging in
  // doesn't duplicate them.
  if (isPrimaryGM()) await ensureLauncherMacros();
  for (const sub of getSubsystems()) sub.onReady?.();
});
