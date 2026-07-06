/**
 * Core + subsystem settings, registered from one declarative table (survival-system
 * house pattern). Each subsystem contributes its own defs via the registry, so this
 * stays subsystem-agnostic.
 */

import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { getSubsystems } from "./subsystems.mjs";

const CORE_SETTINGS = [
  { key: SETTINGS.SCHEMA_VERSION, scope: "world", type: "String", default: "0.0.0", config: false },
  {
    key: SETTINGS.PANEL_DENSITY, scope: "client", type: "String", default: "full", config: true,
    choices: { full: "SHARDS.Settings.panelDensity.full", compact: "SHARDS.Settings.panelDensity.compact" },
  },
];

const TYPE_CTOR = { String, Number, Boolean, Object };

/** Register every core + subsystem setting. Called from `init`. */
export function registerAllSettings() {
  const defs = [...CORE_SETTINGS];
  for (const sub of getSubsystems()) if (Array.isArray(sub.settings)) defs.push(...sub.settings);

  for (const s of defs) {
    const data = {
      scope: s.scope,
      config: s.config,
      type: TYPE_CTOR[s.type],
      default: s.default,
    };
    if (s.choices) data.choices = s.choices;
    if (s.range) data.range = s.range;
    if (s.onChange) data.onChange = s.onChange;
    // Only settings shown in the config UI need a localized label/hint.
    if (s.config) {
      data.name = `SHARDS.Settings.${s.key}.name`;
      data.hint = `SHARDS.Settings.${s.key}.hint`;
    }
    game.settings.register(MODULE_ID, s.key, data);
  }
}
