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
import { registerRechargeHooks, findRechargeEffect, remainingRounds } from "./recharge.mjs";
import { registerTerrorHooks } from "./terror.mjs";
import { setImmersion } from "./transform.mjs";
import { registerIzirTraits } from "./traits.mjs";
import { isMarked } from "./state.mjs";

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

/**
 * Presentational shim on every client: while a recharge effect is active, grey the
 * ability's Use button and show the remaining rounds. Enforcement never depends on
 * this; if a pf2e update shifts the sheet DOM, the whisper guard still holds.
 */
function rechargeSheetShim(app, root) {
  const actor = app?.actor ?? app?.document;
  if (!actor || !isMarked(actor)) return;
  for (const item of actor.items) {
    const tag = item.getFlag?.(MODULE_ID, IZIR);
    if (!tag?.entryId || item.type !== "action") continue;
    const running = findRechargeEffect(actor, tag.entryId);
    const row = root.querySelector?.(`[data-item-id="${item.id}"]`);
    if (!row) continue;
    const btn = row.querySelector('button[data-action="use-action"], [data-action="use-action"]');
    if (!btn) continue;
    if (running) {
      const rounds = remainingRounds(running);
      btn.disabled = true;
      btn.classList.add("izir-recharging");
      btn.dataset.tooltip = game.i18n.format("SHARDS.Izir.StillRecharging", { name: item.name, rounds });
      if (!row.querySelector(".izir-cd")) {
        const badge = document.createElement("span");
        badge.className = "izir-cd";
        badge.textContent = game.i18n.format("SHARDS.Izir.RoundsShort", { rounds });
        btn.before(badge);
      }
    }
  }
}

registerSubsystem({
  id: IZIR,
  titleKey: "SHARDS.Izir.PanelTitle",
  icon: "fa-solid fa-eye",
  macroImg: "icons/magic/perception/eye-ringed-glow-angry-red.webp",
  settings: IZIR_SETTINGS,
  openPanel: (actorUuid, opts) => openIzirPanel(actorUuid, opts),
  refresh: () => refreshIzirPanel(),
  sheetButton: rechargeSheetShim,
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
    registerTerrorHooks();
  },
});
