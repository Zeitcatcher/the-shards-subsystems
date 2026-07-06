/** Shared constants for the umbrella module — no magic strings elsewhere. */

export const MODULE_ID = "the-shards-subsystems";

/** Subsystem keys (also the flag namespace under flags[MODULE_ID]). */
export const IZIR = "izir";

/** Immersion runs 0..10; 10 is the terminal fork (Ниневеш / Подчинение). */
export const MAX_LEVEL = 10;

export const SETTINGS = Object.freeze({
  // Core / umbrella
  SCHEMA_VERSION: "schemaVersion",
  PANEL_DENSITY: "panelDensity",
  // Izir
  IZIR_TRANSPARENCY: "izirTransparency",
  IZIR_DC_BASE: "izirDcBase",
  IZIR_DC_STEP: "izirDcStep",
  IZIR_SHOW_DC: "izirShowDc",
  IZIR_SUGGEST_STREAK: "izirSuggestStreak",
  IZIR_SUGGESTIONS: "izirSuggestions",
  IZIR_ART_SWAP: "izirArtSwap",
  IZIR_TOKEN_ICONS: "izirTokenIcons",
});

export const TEMPLATES = Object.freeze({
  IZIR_PANEL: `modules/${MODULE_ID}/templates/izir/panel.hbs`,
});
