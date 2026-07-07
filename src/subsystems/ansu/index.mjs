/**
 * Ansu subsystem manifest: declares its settings and panel launcher, then
 * self-registers with the umbrella core. The panel is opened from the scene-controls
 * toolbar button, the launcher macro, and the subsystem switcher strip.
 */

import { ANSU, MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { registerSubsystem } from "../../core/subsystems.mjs";
import { openAnsuPanel, refreshAnsuPanel } from "./apps/ansu-panel.mjs";
import { loadContent } from "./content.mjs";
import { registerSyncHooks, syncAllAttuned } from "./sync.mjs";
import { registerCommunionHooks } from "./communion.mjs";
import { registerReleaseHooks } from "./release.mjs";
import { registerCallHooks } from "./call.mjs";
import { setAttunement } from "./transform.mjs";
import { registerAnsuTraits } from "./traits.mjs";

// Release-DC and Climb dials feed numbers BAKED into effects: re-sync on change.
const resyncOnChange = () => {
  syncAllAttuned().catch((err) => console.error(`${MODULE_ID} | ansu dial resync`, err));
  refreshAnsuPanel();
};

const ANSU_SETTINGS = [
  { key: SETTINGS.ANSU_DC_BASE, scope: "world", type: "Number", default: 20, config: true, onChange: resyncOnChange },
  { key: SETTINGS.ANSU_DC_STEP, scope: "world", type: "Number", default: 2, config: true, onChange: resyncOnChange },
  {
    key: SETTINGS.ANSU_DC_CAP, scope: "world", type: "Number", default: 5, config: true,
    range: { min: 1, max: 9, step: 1 }, onChange: resyncOnChange,
  },
  { key: SETTINGS.ANSU_CALL_BASE, scope: "world", type: "Number", default: 20, config: true, onChange: resyncOnChange },
  { key: SETTINGS.ANSU_CALL_STEP, scope: "world", type: "Number", default: 2, config: true, onChange: resyncOnChange },
  {
    key: SETTINGS.ANSU_SHOW_DC, scope: "world", type: "String", default: "gm", config: true,
    choices: {
      gm: "SHARDS.Settings.ansuShowDc.gm",
      owner: "SHARDS.Settings.ansuShowDc.owner",
      all: "SHARDS.Settings.ansuShowDc.all",
    },
  },
  { key: SETTINGS.ANSU_CLIMB_BASE, scope: "world", type: "Number", default: 2, config: true, onChange: () => refreshAnsuPanel() },
  { key: SETTINGS.ANSU_CLIMB_STEP, scope: "world", type: "Number", default: 1, config: true, onChange: () => refreshAnsuPanel() },
  { key: SETTINGS.ANSU_SUGGESTIONS, scope: "world", type: "Boolean", default: true, config: true },
  { key: SETTINGS.ANSU_ART_SWAP, scope: "world", type: "Boolean", default: true, config: true },
  { key: SETTINGS.ANSU_TOKEN_ICONS, scope: "world", type: "Boolean", default: true, config: true },
  // The persistent Attunement marker (badge effect) is optional — GM undecided.
  { key: SETTINGS.ANSU_MARKER, scope: "world", type: "Boolean", default: true, config: true, onChange: resyncOnChange },
];

registerSubsystem({
  id: ANSU,
  titleKey: "SHARDS.Ansu.PanelTitle",
  icon: "fa-solid fa-hand-fist",
  macroImg: "icons/ancestries/minotaur.webp",
  settings: ANSU_SETTINGS,
  openPanel: (actorUuid, opts) => openAnsuPanel(actorUuid, opts),
  refresh: () => refreshAnsuPanel(),
  onSetup: () => registerAnsuTraits(),
  onReady: async () => {
    try {
      await loadContent();
    } catch (err) {
      console.error(`${MODULE_ID} | Ansu content failed to load`, err);
      ui.notifications?.error(game.i18n.localize("SHARDS.Ansu.ContentError"));
    }
    // Token-badge edits are level changes; refresh the panel afterwards.
    registerSyncHooks(async (actor, _from, next) => {
      await setAttunement(actor, next, game.i18n.localize("SHARDS.Ansu.BadgeNote"));
      refreshAnsuPanel();
    });
    registerCommunionHooks();
    registerReleaseHooks();
    registerCallHooks();
  },
});
