/**
 * Umbrella subsystem registry. Each subsystem self-registers at import time with a
 * small descriptor; the core wiring (settings, scene controls, sheet buttons, macros)
 * iterates the registry so adding System 2 later means dropping in one more folder.
 *
 * @typedef {object} SubsystemDef
 * @property {string}   id          - stable key, also the actor-flag namespace
 * @property {string}   titleKey    - i18n key for the panel/macro title
 * @property {string}   icon        - Font Awesome class for the toolbar button
 * @property {string}  [macroImg]   - launcher macro icon
 * @property {Array}   [settings]   - declarative setting defs contributed to core registration
 * @property {(actorId?:string)=>void} openPanel
 * @property {()=>void} [refresh]
 * @property {(app:any, root:HTMLElement)=>void} [sheetButton]
 * @property {()=>void} [onInit]
 * @property {()=>void} [onReady]
 * @property {(from:string, to:string)=>Promise<void>} [onMigrate] - one-time work when the
 *   module version changes; runs on the primary GM after every onReady has settled.
 */

/** @type {SubsystemDef[]} */
const registry = [];

/** @param {SubsystemDef} def */
export function registerSubsystem(def) {
  if (registry.some((s) => s.id === def.id)) return;
  registry.push(def);
}

export function getSubsystems() {
  return registry;
}

export function getSubsystem(id) {
  return registry.find((s) => s.id === id);
}
