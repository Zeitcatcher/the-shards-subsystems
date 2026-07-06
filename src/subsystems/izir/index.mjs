/**
 * Izir subsystem manifest: declares its settings and panel launcher, then
 * self-registers with the umbrella core. The panel is opened from the scene-controls
 * toolbar button and the launcher macro (no per-sheet button).
 */

import { IZIR, MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { registerSubsystem } from "../../core/subsystems.mjs";
import { openIzirPanel, refreshIzirPanel } from "./apps/izir-panel.mjs";
import { loadContent } from "./content.mjs";
import { registerSyncHooks, syncAllMarked } from "./sync.mjs";
import { registerTemptationHooks } from "./temptation.mjs";
import { registerRechargeHooks } from "./recharge.mjs";
import { setImmersion } from "./transform.mjs";
import { registerIzirTraits } from "./traits.mjs";

const IZIR_SETTINGS = [
  {
    key: SETTINGS.IZIR_TRANSPARENCY, scope: "world", type: "Boolean", default: false, config: true,
    // Full-transparency flips every bane to identified: resync all marked actors.
    onChange: () => {
      syncAllMarked().catch((err) => console.error(`${MODULE_ID} | transparency resync`, err));
      refreshIzirPanel();
    },
  },
  { key: SETTINGS.IZIR_DC_BASE, scope: "world", type: "Number", default: 20, config: true },
  { key: SETTINGS.IZIR_DC_STEP, scope: "world", type: "Number", default: 3, config: true },
  {
    key: SETTINGS.IZIR_SHOW_DC, scope: "world", type: "String", default: "gm", config: true,
    choices: {
      gm: "SHARDS.Settings.izirShowDc.gm",
      owner: "SHARDS.Settings.izirShowDc.owner",
      all: "SHARDS.Settings.izirShowDc.all",
    },
  },
  {
    key: SETTINGS.IZIR_SUGGEST_STREAK, scope: "world", type: "Number", default: 3, config: true,
    range: { min: 1, max: 6, step: 1 },
  },
  { key: SETTINGS.IZIR_SUGGESTIONS, scope: "world", type: "Boolean", default: true, config: true },
  { key: SETTINGS.IZIR_ART_SWAP, scope: "world", type: "Boolean", default: true, config: true },
  { key: SETTINGS.IZIR_TOKEN_ICONS, scope: "world", type: "Boolean", default: true, config: true },
];

registerSubsystem({
  id: IZIR,
  titleKey: "SHARDS.Izir.PanelTitle",
  icon: "fa-solid fa-eye",
  macroImg: "icons/abilities/purple-eye.webp",
  settings: IZIR_SETTINGS,
  openPanel: (actorUuid) => openIzirPanel(actorUuid),
  refresh: () => refreshIzirPanel(),
  onSetup: () => registerIzirTraits(),
  onReady: async () => {
    try {
      await loadContent();
    } catch (err) {
      console.error(`${MODULE_ID} | Izir content failed to load`, err);
      ui.notifications?.error(game.i18n.localize("SHARDS.Izir.ContentError"));
    }
    // Token-badge edits are level changes; refresh the panel afterwards.
    registerSyncHooks(async (actor, _from, next) => {
      await setImmersion(actor, next, game.i18n.localize("SHARDS.Izir.BadgeNote"));
      refreshIzirPanel();
    });
    registerTemptationHooks();
    registerRechargeHooks();
  },
});
