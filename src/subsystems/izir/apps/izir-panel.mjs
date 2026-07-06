/**
 * Izir GM control panel (ApplicationV2 + HandlebarsApplicationMixin).
 * Roster of marked actors + a tabbed detail. Every mutation goes flags → syncActor →
 * re-render; the panel never touches items directly.
 *
 * Actors are keyed by UUID (not id) so unlinked token actors — the usual case for
 * NPC tokens dropped on a scene — are tracked correctly, not just world actors.
 */

import { MODULE_ID, SETTINGS, TEMPLATES } from "../../../core/constants.mjs";
import {
  readIzir,
  patchIzir,
  appendLog,
  listMarkedActors,
  isMarked,
  markActor,
  unmarkActor,
} from "../state.mjs";
import { tierForLevel, clampLevel, dcFor, MAX_LEVEL } from "../logic/model.mjs";
import { suggestChips } from "../logic/suggest.mjs";
import { loadContent } from "../content.mjs";
import { syncActor } from "../sync.mjs";
import {
  openTemptationDialog,
  recordTemptationOutcome,
  clearPendingTemptation,
  postSurge,
  postReminder,
} from "../temptation.mjs";
import { exportLog, describeEntry } from "../journal.mjs";
import { triggerFork } from "../transform.mjs";
import { applyThresholdArt, revertArt, maybeSwapForLevel } from "../art.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const dcBase = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_BASE)) || 14;
const dcStep = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_STEP)) || 0;
const TIER_ORDER = ["whisper", "grip", "call", "nineveh", "subjugated"];

/** Resolve any actor (world or token) from its UUID. */
const resolveActor = (uuid) => (uuid ? fromUuidSync(uuid) : null);

function tierLabel(st) {
  if (st.terminal === "subjugated") return game.i18n.localize("SHARDS.Izir.Tier.subjugated");
  return game.i18n.localize(tierForLevel(st.level).nameKey);
}
function tierId(st) {
  return st.terminal === "subjugated" ? "subjugated" : tierForLevel(st.level).id;
}
function entryTierId(entry) {
  return entry.gate === "subjugated" ? "subjugated" : tierForLevel(entry.level).id;
}

// ---- action handlers (Foundry binds `this` to the application instance) ----

async function onSelectActor(_event, target) {
  this._actorUuid = target.dataset.actor;
  this.render();
}

async function onTab(_event, target) {
  this._tab = target.dataset.tab;
  this.render();
}

async function onMarkSelected() {
  const tokens = canvas.tokens?.controlled ?? [];
  if (!tokens.length) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.MarkedNone"));
    return;
  }
  let n = 0;
  let already = 0;
  for (const t of tokens) {
    const actor = t.actor;
    if (!actor) continue;
    if (isMarked(actor)) {
      already += 1;
      this._actorUuid = actor.uuid; // focus the already-tracked one so it's visible
      continue;
    }
    await markActor(actor);
    await appendLog(actor, "mark", {});
    await syncActor(actor);
    this._actorUuid = actor.uuid;
    n += 1;
  }
  if (n) ui.notifications?.info(game.i18n.format("SHARDS.Izir.MarkedDone", { n }));
  else if (already) ui.notifications?.info(game.i18n.localize("SHARDS.Izir.MarkedAlready"));
  else ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.MarkedNone"));
  this.render();
}

async function onUnmark(_event, target) {
  const actor = resolveActor(target.dataset.actor);
  if (!actor) return;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("SHARDS.Izir.Unmark") },
    content: `<p>${game.i18n.format("SHARDS.Izir.UnmarkConfirm", { name: actor.name })}</p>`,
  }).catch(() => false);
  if (!ok) return;
  // Strip module items first (enabled:false → empty desired set), then drop the flag.
  await patchIzir(actor, { enabled: false });
  await syncActor(actor);
  await unmarkActor(actor);
  if (this._actorUuid === actor.uuid) this._actorUuid = null;
  this.render();
}

async function onLevelUp(_event, target) {
  await stepLevel.call(this, target.dataset.actor, +1);
}
async function onLevelDown(_event, target) {
  await stepLevel.call(this, target.dataset.actor, -1);
}

async function stepLevel(actorUuid, delta) {
  const actor = resolveActor(actorUuid);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return; // terminal state is locked
  const next = clampLevel(st.level + delta);
  if (next === st.level) return;
  // Reaching the top opens the fork dialog (Nineveh / Subjugation) instead of a plain set.
  if (next >= MAX_LEVEL && delta > 0) {
    await triggerFork(actor);
    this.render();
    return;
  }
  await patchIzir(actor, { level: next });
  await appendLog(actor, "level", { from: st.level, to: next });
  await syncActor(actor);
  await maybeSwapForLevel(actor, next);
  this.render();
}

async function onToggleSuppress(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const family = target.dataset.family;
  const st = readIzir(actor);
  const has = st.suppressed.some((s) => s.id === family);
  const suppressed = has
    ? st.suppressed.filter((s) => s.id !== family)
    : [...st.suppressed, { id: family, reason: "", at: Date.now() }];
  await patchIzir(actor, { suppressed });
  await appendLog(actor, "suppress", { id: family, on: !has });
  await syncActor(actor);
  this.render();
}

async function onEditReason(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const family = target.dataset.family;
  const st = readIzir(actor);
  const rec = st.suppressed.find((s) => s.id === family);
  if (!rec) return;
  const reason = await promptText(rec.reason ?? "", "SHARDS.Izir.ReasonPrompt");
  if (reason === null) return;
  const suppressed = st.suppressed.map((s) => (s.id === family ? { ...s, reason } : s));
  await patchIzir(actor, { suppressed });
  await appendLog(actor, "suppress", { id: family, reason }, reason);
  this.render();
}

async function onToggleReveal(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const family = target.dataset.family;
  const st = readIzir(actor);
  const has = st.revealed.includes(family);
  const revealed = has ? st.revealed.filter((f) => f !== family) : [...st.revealed, family];
  await patchIzir(actor, { revealed });
  await appendLog(actor, "reveal", { id: family, on: !has });
  await syncActor(actor);
  this.render();
}

async function onTempt() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await openTemptationDialog(actor);
  this.render();
}

async function onRecordOutcome(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await recordTemptationOutcome(actor, target.dataset.outcome, null);
  this.render();
}

async function onClearPending() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await clearPendingTemptation(actor);
  this.render();
}

async function onChip(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  switch (target.dataset.chip) {
    case "suggestSuppress":
    case "suggestUnsuppress":
      this._tab = "effects";
      break;
    case "suggestDeepen":
      await stepLevel.call(this, actor.uuid, +1);
      break;
    case "suggestSurge":
      await postSurge(actor);
      break;
    case "suggestRemind":
      await postReminder(actor);
      break;
    default:
      break;
  }
  this.render();
}

async function onExportJournal() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await exportLog(actor);
}

async function onArtBrowse(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const threshold = target.dataset.threshold;
  const field = target.dataset.field;
  const st = readIzir(actor);
  const current = st.art.thresholds?.[threshold]?.[field] ?? "";
  const FP = foundry.applications.apps.FilePicker?.implementation ?? FilePicker;
  const picker = new FP({
    type: "imagevideo",
    current,
    callback: async (path) => {
      await patchIzir(actor, { art: { thresholds: { [threshold]: { [field]: path } } } });
      this.render();
    },
  });
  picker.render(true);
}

async function onArtClear(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const threshold = target.dataset.threshold;
  await patchIzir(actor, { art: { thresholds: { [threshold]: { portrait: "", token: "" } } } });
  this.render();
}

async function onArtApply(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const applied = await applyThresholdArt(actor, target.dataset.threshold);
  if (!applied) ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.ArtNone"));
  this.render();
}

async function onArtRevert() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await revertArt(actor);
  this.render();
}

async function promptText(initial, titleKey) {
  try {
    const value = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize(titleKey) },
      content: `<input type="text" name="value" value="${foundry.utils.escapeHTML(initial)}" autofocus style="width:100%">`,
      ok: {
        label: game.i18n.localize("SHARDS.Izir.Set"),
        callback: (_ev, button) => String(button.form.elements.value.value ?? "").trim(),
      },
    });
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Build the Effects-tab view for a selected actor: one collapsed row per family. */
function buildEffectsView(actor, content) {
  const st = readIzir(actor);
  const suppressed = new Map(st.suppressed.map((s) => [s.id, s.reason ?? ""]));
  const revealed = new Set(st.revealed);
  const subjugated = st.terminal === "subjugated";

  const rows = [];
  for (const [family, list] of content.byFamily) {
    const sorted = [...list].sort((a, b) => a.rank - b.rank);
    const gate = sorted[0].gate ?? null;
    const unlockedRanks = sorted.filter((e) => (gate === "subjugated" ? subjugated : e.level <= st.level));
    const rep = unlockedRanks.length ? unlockedRanks[unlockedRanks.length - 1] : sorted[0];
    const unlocked = unlockedRanks.length > 0;
    const isSuppressed = suppressed.has(family);
    rows.push({
      family,
      name: rep.name,
      isBane: rep.kind === "bane",
      tierId: entryTierId(rep),
      unlocked,
      gate,
      unlockLevel: gate === "subjugated" ? null : Math.min(...sorted.map((e) => e.level)),
      status: isSuppressed ? "suppressed" : unlocked ? "active" : "locked",
      suppressed: isSuppressed,
      reason: suppressed.get(family) ?? "",
      revealed: revealed.has(family),
    });
  }

  const groups = TIER_ORDER.map((id) => ({
    tierId: id,
    label: game.i18n.localize(`SHARDS.Izir.Tier.${id}`),
    rows: rows
      .filter((r) => r.tierId === id)
      .sort((a, b) => (a.unlockLevel ?? 99) - (b.unlockLevel ?? 99) || a.name.localeCompare(b.name)),
  })).filter((g) => g.rows.length);

  return { groups, hasAny: rows.length > 0 };
}

const OUTCOMES = ["criticalSuccess", "success", "failure", "criticalFailure"];

/** Temptation-tab view: DC preview, pending marker, suggestion chips, recent rolls. */
function buildTemptationView(st, dcPreview) {
  const suggestionsOn = game.settings.get(MODULE_ID, SETTINGS.IZIR_SUGGESTIONS) === true;
  const streakNeed = Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_SUGGEST_STREAK)) || 3;
  return {
    dc: dcPreview,
    pending: st.pendingTemptation ? { ...st.pendingTemptation } : null,
    outcomes: OUTCOMES.map((o) => ({ key: o, label: game.i18n.localize(`SHARDS.Izir.Outcome.${o}`) })),
    chips: suggestChips(st.log, { enabled: suggestionsOn, streak: streakNeed }).map((c) => ({
      chip: c.action,
      label: game.i18n.localize(c.labelKey),
    })),
    recent: st.log
      .filter((e) => e.type === "temptation")
      .slice(-6)
      .reverse()
      .map((e) => ({
        when: new Date(e.t).toLocaleString(),
        dc: e.data?.dc ?? "?",
        outcome: e.data?.outcome ? game.i18n.localize(`SHARDS.Izir.Outcome.${e.data.outcome}`) : "—",
        outcomeClass: e.data?.outcome ?? "none",
        reason: e.note ?? "",
      })),
  };
}

/** Art-tab view: three threshold rows (4/7/10) + revert availability. */
function buildArtView(st) {
  return {
    hasOriginal: Boolean(st.art.original),
    appliedThreshold: st.art.applied,
    rows: [4, 7, 10].map((k) => ({
      threshold: String(k),
      label: game.i18n.format("SHARDS.Izir.ArtThreshold", { n: k }),
      portrait: st.art.thresholds?.[k]?.portrait ?? "",
      token: st.art.thresholds?.[k]?.token ?? "",
      applied: st.art.applied === String(k),
      hasArt: Boolean(st.art.thresholds?.[k]?.portrait || st.art.thresholds?.[k]?.token),
    })),
  };
}

/** History-tab view: the full log, newest first. */
function buildHistoryView(st) {
  return {
    hasEntries: st.log.length > 0,
    entries: [...st.log].reverse().map((e) => ({
      when: new Date(e.t).toLocaleString(),
      type: e.type,
      desc: describeEntry(e),
      note: e.note ?? "",
    })),
  };
}

export class IzirPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  _actorUuid = null;
  _tab = "overview";

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-izir`,
    classes: [MODULE_ID, "izir-panel-app"],
    tag: "div",
    window: { title: "SHARDS.Izir.PanelTitle", icon: "fa-solid fa-eye", resizable: true },
    position: { width: 760, height: 640 },
    actions: {
      selectActor: onSelectActor,
      tab: onTab,
      markSelected: onMarkSelected,
      unmark: onUnmark,
      levelUp: onLevelUp,
      levelDown: onLevelDown,
      toggleSuppress: onToggleSuppress,
      editReason: onEditReason,
      toggleReveal: onToggleReveal,
      tempt: onTempt,
      recordOutcome: onRecordOutcome,
      clearPending: onClearPending,
      chip: onChip,
      exportJournal: onExportJournal,
      artBrowse: onArtBrowse,
      artClear: onArtClear,
      artApply: onArtApply,
      artRevert: onArtRevert,
    },
  };

  static PARTS = {
    main: { template: TEMPLATES.IZIR_PANEL },
  };

  async _prepareContext() {
    const marked = listMarkedActors();
    if (this._actorUuid && !marked.some((a) => a.uuid === this._actorUuid)) this._actorUuid = null;
    if (!this._actorUuid && marked.length) this._actorUuid = marked[0].uuid;

    const roster = marked.map((a) => {
      const st = readIzir(a);
      return {
        uuid: a.uuid,
        name: a.name,
        img: a.img,
        level: st.level,
        tierId: tierId(st),
        tierLabel: tierLabel(st),
        terminal: st.terminal,
        pending: Boolean(st.pendingTemptation),
        selected: a.uuid === this._actorUuid,
      };
    });

    const selected = marked.find((a) => a.uuid === this._actorUuid) ?? null;
    let detail = null;
    let effects = null;
    let temptation = null;
    let history = null;
    let art = null;
    if (selected) {
      const st = readIzir(selected);
      detail = {
        uuid: selected.uuid,
        name: selected.name,
        img: selected.img,
        level: st.level,
        maxLevel: MAX_LEVEL,
        tierId: tierId(st),
        tierLabel: tierLabel(st),
        terminal: st.terminal,
        dcPreview: dcFor(st.level, dcBase(), dcStep()),
        suppressedCount: st.suppressed.length,
        canDown: st.level > 0 && !st.terminal,
        canUp: st.level < MAX_LEVEL && !st.terminal,
      };
      const content = await loadContent().catch(() => null);
      if (content) effects = buildEffectsView(selected, content);
      temptation = buildTemptationView(st, detail.dcPreview);
      history = buildHistoryView(st);
      art = buildArtView(st);
    }

    const density = game.settings.get(MODULE_ID, SETTINGS.PANEL_DENSITY);
    return {
      hasRoster: roster.length > 0,
      roster,
      detail,
      effects,
      temptation,
      history,
      art,
      tab: this._tab,
      isOverview: this._tab === "overview",
      isEffects: this._tab === "effects",
      isTemptation: this._tab === "temptation",
      isHistory: this._tab === "history",
      isArt: this._tab === "art",
      densityClass: density === "compact" ? "compact" : "full",
    };
  }
}

let instance;

/** Open (or focus) the Izir panel, optionally focused on a specific actor UUID. */
export function openIzirPanel(actorUuid) {
  instance ??= new IzirPanel();
  if (actorUuid) instance._actorUuid = actorUuid;
  instance.render({ force: true });
}

/** Re-render the panel if it's open (e.g. after an actor flag changes elsewhere). */
export function refreshIzirPanel() {
  if (instance?.rendered) instance.render();
}
