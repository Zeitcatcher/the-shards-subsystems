/** Shared constants for the umbrella module — no magic strings elsewhere. */

export const MODULE_ID = "the-shards-subsystems";

/** Subsystem keys (also the flag namespace under flags[MODULE_ID]). */
export const IZIR = "izir";
export const ANSU = "ansu";

/** Both tracks run 0..10; 10 is a terminal (Izir: fork; Ansu: Mastery or Taken). */
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
  // Ansu
  ANSU_DC_BASE: "ansuDcBase",
  ANSU_DC_STEP: "ansuDcStep",
  ANSU_DC_CAP: "ansuDcCap",
  ANSU_SHOW_DC: "ansuShowDc",
  ANSU_CLIMB_BASE: "ansuClimbBase",
  ANSU_CLIMB_STEP: "ansuClimbStep",
  ANSU_SUGGESTIONS: "ansuSuggestions",
  ANSU_ART_SWAP: "ansuArtSwap",
  ANSU_TOKEN_ICONS: "ansuTokenIcons",
});

export const TEMPLATES = Object.freeze({
  IZIR_PANEL: `modules/${MODULE_ID}/templates/izir/panel.hbs`,
  IZIR_ART: `modules/${MODULE_ID}/templates/izir/art-dialog.hbs`,
  IZIR_HISTORY: `modules/${MODULE_ID}/templates/izir/history-dialog.hbs`,
  ANSU_PANEL: `modules/${MODULE_ID}/templates/ansu/panel.hbs`,
  ANSU_ART: `modules/${MODULE_ID}/templates/ansu/art-dialog.hbs`,
  ANSU_HISTORY: `modules/${MODULE_ID}/templates/ansu/history-dialog.hbs`,
});
