/**
 * The Shards — Campaign Subsystems: umbrella entry point.
 * Wires Foundry hooks to the shared core and to each registered subsystem; holds no
 * game logic itself.
 */

import { MODULE_ID, SETTINGS, TEMPLATES } from "./core/constants.mjs";
import { registerAllSettings } from "./core/settings.mjs";
import { registerControls, ensureLauncherMacros } from "./core/controls.mjs";
import { registerSheetButtons } from "./core/sheet-buttons.mjs";
import { getSubsystems, getSubsystem } from "./core/subsystems.mjs";
import { isPrimaryGM } from "./core/platform.mjs";

// Subsystems self-register at import time.
import "./subsystems/izir/index.mjs";
import "./subsystems/ansu/index.mjs";

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
  for (const sub of getSubsystems()) sub.onSetup?.();
});

Hooks.once("ready", async () => {
  // Only the primary GM creates world documents (macros), so a second GM logging in
  // doesn't duplicate them.
  if (isPrimaryGM()) await ensureLauncherMacros();
  // Awaited — concurrently, so no subsystem waits on another — because the
  // migrations below need fully-started subsystems, and because an onReady that
  // threw used to disappear as an unhandled rejection.
  await Promise.all(
    getSubsystems().map((sub) =>
      Promise.resolve(sub.onReady?.()).catch((err) => console.error(`${MODULE_ID} | ${sub.id} onReady`, err)),
    ),
  );
  if (isPrimaryGM()) await runMigrations();
});

/**
 * One-time work gated on the module version.
 *
 * The stored world setting is the last version that finished migrating. Each
 * subsystem gets one `onMigrate(from, to)` call, and the setting is written only
 * after every one of them succeeds — a failure leaves the old version in place so
 * the next load tries again rather than silently skipping the work. (F10)
 */
async function runMigrations() {
  const to = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  const from = game.settings.get(MODULE_ID, SETTINGS.SCHEMA_VERSION) || "0.0.0";
  if (!to || from === to) return;
  try {
    for (const sub of getSubsystems()) await sub.onMigrate?.(from, to);
    await game.settings.set(MODULE_ID, SETTINGS.SCHEMA_VERSION, to);
    console.log(`${MODULE_ID} | migrated ${from} -> ${to}`);
  } catch (err) {
    console.error(`${MODULE_ID} | migration ${from} -> ${to} failed; retrying on next load`, err);
  }
}
