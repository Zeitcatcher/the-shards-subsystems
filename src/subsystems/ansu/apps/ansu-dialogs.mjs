/**
 * Small satellite windows off the Ansu panel footer: per-actor art thresholds
 * (the horn stages) and the full history log. Both are read-through views over
 * the actor's flag state.
 */

import { MODULE_ID, TEMPLATES } from "../../../core/constants.mjs";
import { readAnsu, patchAnsu } from "../state.mjs";
import { applyThresholdArt, revertArt } from "../art.mjs";
import { exportLog, describeEntry } from "../journal.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const resolveActor = (uuid) => (uuid ? fromUuidSync(uuid) : null);

/* ------------------------------------------------------------------ */
/* Art thresholds                                                      */
/* ------------------------------------------------------------------ */

async function onArtBrowse(_event, target) {
  const actor = resolveActor(this.actorUuid);
  if (!actor) return;
  const { threshold, field } = target.dataset;
  const st = readAnsu(actor);
  const current = st.art.thresholds?.[threshold]?.[field] ?? "";
  const FP = foundry.applications.apps.FilePicker?.implementation ?? FilePicker;
  new FP({
    type: "imagevideo",
    current,
    callback: async (path) => {
      await patchAnsu(actor, { art: { thresholds: { [threshold]: { [field]: path } } } });
      this.render();
    },
  }).render(true);
}

async function onArtClear(_event, target) {
  const actor = resolveActor(this.actorUuid);
  if (!actor) return;
  await patchAnsu(actor, { art: { thresholds: { [target.dataset.threshold]: { portrait: "", token: "" } } } });
  this.render();
}

async function onArtApply(_event, target) {
  const actor = resolveActor(this.actorUuid);
  if (!actor) return;
  const applied = await applyThresholdArt(actor, target.dataset.threshold);
  if (!applied) ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.ArtNone"));
  this.render();
}

async function onArtRevert() {
  const actor = resolveActor(this.actorUuid);
  if (!actor) return;
  await revertArt(actor);
  this.render();
}

export class AnsuArtDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actorUuid, options = {}) {
    super(options);
    this.actorUuid = actorUuid;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-ansu-art`,
    classes: [MODULE_ID, "ansu-satellite"],
    tag: "div",
    window: { title: "SHARDS.Ansu.ArtTitle", icon: "fa-solid fa-image", resizable: true },
    position: { width: 460, height: "auto" },
    actions: { artBrowse: onArtBrowse, artClear: onArtClear, artApply: onArtApply, artRevert: onArtRevert },
  };

  static PARTS = { main: { template: TEMPLATES.ANSU_ART } };

  async _prepareContext() {
    const actor = resolveActor(this.actorUuid);
    if (!actor) return { rows: [], hasOriginal: false, name: "" };
    const st = readAnsu(actor);
    return {
      name: actor.name,
      hasOriginal: Boolean(st.art.original),
      rows: [4, 7, 10].map((k) => ({
        threshold: String(k),
        label: game.i18n.format("SHARDS.Ansu.ArtThreshold", { n: k }),
        hint: game.i18n.localize(`SHARDS.Ansu.ArtStage.${k}`),
        portrait: st.art.thresholds?.[k]?.portrait ?? "",
        token: st.art.thresholds?.[k]?.token ?? "",
        applied: st.art.applied === String(k),
        hasArt: Boolean(st.art.thresholds?.[k]?.portrait || st.art.thresholds?.[k]?.token),
      })),
    };
  }
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

async function onExport() {
  const actor = resolveActor(this.actorUuid);
  if (actor) await exportLog(actor);
}

export class AnsuHistoryDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actorUuid, options = {}) {
    super(options);
    this.actorUuid = actorUuid;
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-ansu-history`,
    classes: [MODULE_ID, "ansu-satellite"],
    tag: "div",
    window: { title: "SHARDS.Ansu.HistoryTitle", icon: "fa-solid fa-book", resizable: true },
    position: { width: 520, height: 480 },
    actions: { exportJournal: onExport },
  };

  static PARTS = { main: { template: TEMPLATES.ANSU_HISTORY } };

  async _prepareContext() {
    const actor = resolveActor(this.actorUuid);
    if (!actor) return { entries: [], hasEntries: false, name: "" };
    const st = readAnsu(actor);
    return {
      name: actor.name,
      hasEntries: st.log.length > 0,
      entries: [...st.log].reverse().map((e) => ({
        when: new Date(e.t).toLocaleString(),
        type: e.type,
        desc: describeEntry(e),
        note: e.note ?? "",
      })),
    };
  }
}

export function openArtDialog(actorUuid) {
  new AnsuArtDialog(actorUuid).render({ force: true });
}
export function openHistoryDialog(actorUuid) {
  new AnsuHistoryDialog(actorUuid).render({ force: true });
}
