/**
 * Izir GM control panel — the approved one-screen dashboard. No tabs: the level
 * ladder IS the interface (suppress / reveal / reason act directly on its chips),
 * the slide bar and the temptation block are always visible, and Art / History
 * open as satellite dialogs. Actors are keyed by UUID so unlinked token actors
 * work. Every mutation goes flags → syncActor → re-render.
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
import { tierForLevel, izirAttack, izirDC, slideNeeded, MAX_LEVEL } from "../logic/model.mjs";
import { selectEntries, buildCtx, injectNumbers } from "../logic/reconcile.mjs";
import { suggestChips } from "../logic/suggest.mjs";
import { loadContent } from "../content.mjs";
import { syncActor, syncAllMarked } from "../sync.mjs";
import {
  callTemptation,
  suggestedDC,
  recordTemptationOutcome,
  clearPendingTemptation,
  postSurge,
  postReminder,
} from "../temptation.mjs";
import { exportLog } from "../journal.mjs";
import { triggerFork, setImmersion, applySlideChange } from "../transform.mjs";
import { openArtDialog, openHistoryDialog } from "./izir-dialogs.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TIER_GROUPS = [
  { id: "whisper", levels: [1, 2, 3] },
  { id: "grip", levels: [4, 5, 6] },
  { id: "call", levels: [7, 8, 9] },
];

const resolveActor = (uuid) => (uuid ? fromUuidSync(uuid) : null);

function tierIdFor(st) {
  if (st.terminal === "subjugated") return "subjugated";
  if (st.terminal === "nineveh") return "nineveh";
  return tierForLevel(st.level).id;
}
function tierLabelFor(st) {
  return game.i18n.localize(`SHARDS.Izir.Tier.${tierIdFor(st)}`);
}

/* ------------------------------------------------------------------ */
/* Action handlers (Foundry binds `this` to the app instance)          */
/* ------------------------------------------------------------------ */

async function onSelectActor(_event, target) {
  this._actorUuid = target.dataset.actor;
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
      this._actorUuid = actor.uuid;
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
  await patchIzir(actor, { enabled: false });
  await syncActor(actor);
  await unmarkActor(actor);
  if (this._actorUuid === actor.uuid) this._actorUuid = null;
  this.render();
}

async function onLevelUp() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return;
  if (st.level >= MAX_LEVEL - 1) {
    await triggerFork(actor);
  } else {
    await setImmersion(actor, st.level + 1);
  }
  this.render();
}

async function onLevelDown() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return;
  await setImmersion(actor, st.level - 1);
  this.render();
}

async function onFork() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return;
  await triggerFork(actor);
  this.render();
}

async function onSlidePlus() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await applySlideChange(actor, { delta: +1, source: "gm" });
  this.render();
}
async function onSlideMinus() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await applySlideChange(actor, { delta: -1, source: "gm" });
  this.render();
}
async function onSlideSet(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const value = Number(target.dataset.value);
  if (!Number.isFinite(value)) return;
  const st = readIzir(actor);
  // Clicking the first filled segment clears the bar; anything else sets to it.
  const set = value === 1 && (st.slide ?? 0) === 1 ? 0 : value;
  await applySlideChange(actor, { set, source: "gm" });
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
  if (!actor) return;
  const dcInput = this.element.querySelector('input[name="temptDc"]');
  const reasonInput = this.element.querySelector('input[name="temptReason"]');
  const dc = Number(dcInput?.value);
  const reason = String(reasonInput?.value ?? "").trim();
  if (!Number.isFinite(dc) || dc < 1) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.BadDc"));
    return;
  }
  this._reasonDraft = "";
  this._dcDraft = null;
  await callTemptation(actor, dc, reason);
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
    case "suggestUnsuppress": {
      const ladder = this.element.querySelector(".izir-ladder");
      ladder?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      ladder?.classList.add("pulse");
      setTimeout(() => ladder?.classList.remove("pulse"), 1600);
      return; // no re-render — keep the pulse visible
    }
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

async function onResync(event) {
  if (event?.shiftKey) {
    await syncAllMarked();
    ui.notifications?.info(game.i18n.localize("SHARDS.Izir.ResyncAllDone"));
  } else {
    const actor = resolveActor(this._actorUuid);
    if (!actor) return;
    await syncActor(actor);
    ui.notifications?.info(game.i18n.format("SHARDS.Izir.ResyncDone", { name: actor.name }));
  }
  this.render();
}

async function onOpenArt() {
  if (this._actorUuid) openArtDialog(this._actorUuid);
}
async function onOpenHistory() {
  if (this._actorUuid) openHistoryDialog(this._actorUuid);
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

/* ------------------------------------------------------------------ */
/* View-model builders                                                 */
/* ------------------------------------------------------------------ */

function chipFor(entry, st, replacedIds, transparency, ctx) {
  const suppressedRec = st.suppressed.find((s) => s.id === entry.family);
  const isBane = entry.kind === "bane";
  const isActive = entry.form === "action" || entry.form === "strike";
  let tag = null;
  if (entry.chipTag) tag = injectNumbers(entry.chipTag, ctx);
  else if (entry.form === "strike") tag = game.i18n.localize("SHARDS.Izir.TagStrike");
  else if (entry.actionData?.recharge) tag = `R ${entry.actionData.recharge}`;
  else if (entry.actionData?.frequency?.per === "day") tag = "1/day";
  if (replacedIds.includes(entry.id)) tag = game.i18n.format("SHARDS.Izir.TagReplaced", { rank: "" }).trim();
  const nActions = entry.actionData?.actions ?? 0;
  return {
    family: entry.family,
    name: entry.name,
    isBane,
    isActive,
    isPassive: !isBane && !isActive,
    actionsGlyph: isActive && nActions ? "◆".repeat(nActions) : "",
    tag,
    replaced: replacedIds.includes(entry.id),
    suppressed: Boolean(suppressedRec),
    reason: suppressedRec?.reason ?? "",
    revealed: !isBane || transparency || st.revealed.includes(entry.family),
    showEye: isBane && !transparency,
  };
}

function buildLadder(st, content, transparency, charLevel) {
  const { replacedIds } = selectEntries({ ...st, suppressed: [] }, content);
  const ctx = buildCtx(charLevel, Math.max(1, st.level));
  const groups = TIER_GROUPS.map((g) => ({
    tierId: g.id,
    label: game.i18n.localize(`SHARDS.Izir.Tier.${g.id}`),
    range: `${g.levels[0]}–${g.levels[g.levels.length - 1]}`,
    rows: g.levels.map((lvl) => ({
      level: lvl,
      current: !st.terminal && st.level === lvl,
      locked: st.level < lvl,
      chips: content.entries
        .filter((e) => e.level === lvl && !e.gate)
        .sort((a, b) => Number(a.kind === "bane") - Number(b.kind === "bane") || a.id.localeCompare(b.id))
        .map((e) => chipFor(e, st, replacedIds, transparency, ctx)),
    })),
  }));

  const gateChips = content.entries
    .filter((e) => e.gate === "subjugated")
    .map((e) => chipFor(e, st, replacedIds, transparency, ctx));

  return { groups, gateChips };
}

function buildSlide(st) {
  if (st.terminal || st.level < 1 || st.level >= MAX_LEVEL) return null;
  const needed = slideNeeded(st.level);
  const value = Math.min(st.slide ?? 0, needed);
  return {
    value,
    needed,
    nextLevel: st.level + 1,
    full: value >= needed,
    segments: Array.from({ length: needed }, (_, i) => ({
      value: i + 1,
      filled: i < value,
      gap: i > 0 && i % 3 === 0,
    })),
  };
}

const OUTCOMES = ["criticalSuccess", "success", "failure", "criticalFailure"];

function buildTemptation(st, dcPreview) {
  const suggestionsOn = game.settings.get(MODULE_ID, SETTINGS.IZIR_SUGGESTIONS) === true;
  const streakNeed = Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_SUGGEST_STREAK)) || 3;
  return {
    dc: dcPreview,
    subjugated: st.terminal === "subjugated",
    consumed: st.terminal === "nineveh",
    pending: st.pendingTemptation ? { ...st.pendingTemptation } : null,
    outcomes: OUTCOMES.map((o) => ({ key: o, label: game.i18n.localize(`SHARDS.Izir.Outcome.${o}`) })),
    chips: suggestChips(st.log, { enabled: suggestionsOn, streak: streakNeed }).map((c) => ({
      chip: c.action,
      label: game.i18n.localize(c.labelKey),
    })),
    recent: st.log
      .filter((e) => e.type === "temptation")
      .slice(-4)
      .reverse()
      .map((e) => ({
        outcome: e.data?.outcome ?? "none",
        label: e.data?.outcome ? game.i18n.localize(`SHARDS.Izir.OutcomeShort.${e.data.outcome}`) : "—",
        slide: e.data?.slideDelta > 0 ? `+${e.data.slideDelta}` : "±0",
      })),
  };
}

/* ------------------------------------------------------------------ */
/* The application                                                     */
/* ------------------------------------------------------------------ */

export class IzirPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  _actorUuid = null;
  _dcDraft = null;
  _reasonDraft = "";

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-izir`,
    classes: [MODULE_ID, "izir-panel-app"],
    tag: "div",
    window: { title: "SHARDS.Izir.PanelTitle", icon: "fa-solid fa-eye", resizable: true },
    position: { width: 840, height: 760 },
    actions: {
      selectActor: onSelectActor,
      markSelected: onMarkSelected,
      unmark: onUnmark,
      levelUp: onLevelUp,
      levelDown: onLevelDown,
      fork: onFork,
      slidePlus: onSlidePlus,
      slideMinus: onSlideMinus,
      slideSet: onSlideSet,
      toggleSuppress: onToggleSuppress,
      editReason: onEditReason,
      toggleReveal: onToggleReveal,
      tempt: onTempt,
      recordOutcome: onRecordOutcome,
      clearPending: onClearPending,
      chip: onChip,
      exportJournal: onExportJournal,
      resync: onResync,
      openArt: onOpenArt,
      openHistory: onOpenHistory,
    },
  };

  static PARTS = {
    main: { template: TEMPLATES.IZIR_PANEL },
  };

  _onRender(context, options) {
    super._onRender?.(context, options);
    // Keep the temptation inputs alive across re-renders.
    const dcInput = this.element.querySelector('input[name="temptDc"]');
    const reasonInput = this.element.querySelector('input[name="temptReason"]');
    if (dcInput) {
      if (this._dcDraft !== null) dcInput.value = this._dcDraft;
      dcInput.addEventListener("input", () => (this._dcDraft = dcInput.value));
    }
    if (reasonInput) {
      if (this._reasonDraft) reasonInput.value = this._reasonDraft;
      reasonInput.addEventListener("input", () => (this._reasonDraft = reasonInput.value));
    }
  }

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
        tierId: tierIdFor(st),
        tierLabel: tierLabelFor(st),
        terminal: st.terminal,
        pending: Boolean(st.pendingTemptation),
        selected: a.uuid === this._actorUuid,
      };
    });

    const selected = marked.find((a) => a.uuid === this._actorUuid) ?? null;
    let detail = null;
    let ladder = null;
    let slide = null;
    let temptation = null;
    if (selected) {
      const st = readIzir(selected);
      const charLevel = Math.max(1, Number(selected.system?.details?.level?.value ?? selected.level ?? 1) || 1);
      const casting = st.level >= 1 || st.terminal === "subjugated";
      detail = {
        uuid: selected.uuid,
        name: selected.name,
        img: selected.img,
        level: st.level,
        maxLevel: MAX_LEVEL,
        tierId: tierIdFor(st),
        tierLabel: tierLabelFor(st),
        terminal: st.terminal,
        attack: casting ? `+${izirAttack(charLevel, Math.max(1, st.level))}` : "—",
        powerDc: casting ? izirDC(charLevel, Math.max(1, st.level)) : "—",
        suppressedCount: st.suppressed.length,
        canDown: st.level > 0 && !st.terminal,
        canUp: !st.terminal,
        atNinth: !st.terminal && st.level === MAX_LEVEL - 1,
      };
      const dcPreview = suggestedDC(st);
      detail.temptDc = this._dcDraft ?? dcPreview;
      const content = await loadContent().catch(() => null);
      const transparency = game.settings.get(MODULE_ID, SETTINGS.IZIR_TRANSPARENCY) === true;
      if (content) ladder = buildLadder(st, content, transparency, charLevel);
      slide = buildSlide(st);
      temptation = buildTemptation(st, dcPreview);
    }

    const density = game.settings.get(MODULE_ID, SETTINGS.PANEL_DENSITY);
    return {
      hasRoster: roster.length > 0,
      roster,
      detail,
      ladder,
      slide,
      temptation,
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
