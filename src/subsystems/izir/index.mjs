/**
 * Izir subsystem manifest: declares its settings, panel launcher, and best-effort
 * sheet button, then self-registers with the umbrella core.
 */

import { IZIR, MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { registerSubsystem } from "../../core/subsystems.mjs";
import { openIzirPanel, refreshIzirPanel } from "./apps/izir-panel.mjs";
import { loadContent } from "./content.mjs";
import { registerSyncHooks, syncAllMarked } from "./sync.mjs";
import { registerTemptationHooks } from "./temptation.mjs";

const IZIR_SETTINGS = [
  {
    key: SETTINGS.IZIR_TRANSPARENCY, scope: "world", type: "Boolean", default: false, config: true,
    // Full-transparency flips every bane to identified: resync all marked actors.
    onChange: () => {
      syncAllMarked().catch((err) => console.error(`${MODULE_ID} | transparency resync`, err));
      refreshIzirPanel();
    },
  },
  { key: SETTINGS.IZIR_DC_BASE, scope: "world", type: "Number", default: 14, config: true },
  { key: SETTINGS.IZIR_DC_STEP, scope: "world", type: "Number", default: 2, config: true },
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

/** Inject a GM-only "open Izir panel" button into a pf2e actor sheet header. */
function izirSheetButton(app, root) {
  const actor = app?.actor ?? app?.document;
  if (!actor || !game.user?.isGM) return;
  const header = root.querySelector?.(".window-header");
  if (!header || header.querySelector(".shards-izir-header-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control icon shards-izir-header-btn";
  btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
  btn.setAttribute("data-tooltip", game.i18n.localize("SHARDS.Izir.OpenForActor"));
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openIzirPanel(actor.id);
  });

  const closeBtn = header.querySelector('[data-action="close"]');
  if (closeBtn) header.insertBefore(btn, closeBtn);
  else header.appendChild(btn);
}

registerSubsystem({
  id: IZIR,
  titleKey: "SHARDS.Izir.PanelTitle",
  icon: "fa-solid fa-eye",
  macroImg: "icons/svg/eye.svg",
  settings: IZIR_SETTINGS,
  openPanel: (actorId) => openIzirPanel(actorId),
  refresh: () => refreshIzirPanel(),
  sheetButton: izirSheetButton,
  onReady: async () => {
    try {
      await loadContent();
    } catch (err) {
      console.error(`${MODULE_ID} | Izir content failed to load`, err);
      ui.notifications?.error(game.i18n.localize("SHARDS.Izir.ContentError"));
    }
    registerSyncHooks();
    registerTemptationHooks();
  },
});
