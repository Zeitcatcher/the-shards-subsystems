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
import { registerTemptationHooks } from "./mechanics/temptation.mjs";
import { registerRechargeHooks, rechargeSheetShim } from "./mechanics/recharge.mjs";
import { registerTerrorHooks } from "./mechanics/terror.mjs";
import { setImmersion } from "./transform.mjs";

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
  macroImg: "icons/magic/perception/eye-ringed-glow-angry-red.webp",
  settings: IZIR_SETTINGS,
  openPanel: (actorUuid, opts) => openIzirPanel(actorUuid, opts),
  refresh: () => refreshIzirPanel(),
  sheetButton: rechargeSheetShim,
  onReady: async () => {
    // Hooks FIRST, content second. Registration used to sit behind the content
    // fetch, and a Use or a save landing in that window was missed for good. (F29)
    registerSyncHooks(
      // Token-badge edits are level changes; refresh the panel afterwards.
      async (actor, _from, next) => {
        await setImmersion(actor, next, game.i18n.localize("SHARDS.Izir.BadgeNote"));
        refreshIzirPanel();
      },
      () => refreshIzirPanel(),
    );
    registerTemptationHooks();
    registerRechargeHooks();
    registerTerrorHooks();

    // The roster is built from placed tokens, so it has to follow them. Without
    // this, deleting the selected unlinked token left a dashboard whose buttons
    // did nothing, and a newly dropped marked token did not appear at all. (F28)
    for (const hook of ["createToken", "deleteToken", "deleteActor"]) {
      Hooks.on(hook, () => refreshIzirPanel());
    }

    try {
      await loadContent();
    } catch (err) {
      console.error(`${MODULE_ID} | Izir content failed to load`, err);
      ui.notifications?.error(game.i18n.localize("SHARDS.Izir.ContentError"));
    }
    refreshIzirPanel();
  },
  onMigrate: async (from, to) => {
    // 0.7.0 moved every selfEffect and aura uuid into the new izir-internal pack.
    // The composed content hash cannot see a uuid change on an item that is already
    // built, so a plain sync would leave every tracked actor pointing at documents
    // that no longer exist. Force the rebuild once, on version change. (F10)
    const n = await syncAllMarked({ force: true });
    console.log(`${MODULE_ID} | Izir: rebuilt ${n} item(s) upgrading ${from} -> ${to}`);
  },
});
