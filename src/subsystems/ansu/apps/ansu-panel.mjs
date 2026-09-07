/**
 * Ansu GM control panel — same one-screen anatomy as the approved Izir dashboard:
 * roster · identity · stats · Communion control bar · the Climb · ladder · Release
 * block · footer. No tabs; Art / History are satellite dialogs. Actors are keyed
 * by UUID so unlinked token actors work. Every mutation goes flags → syncActor →
 * re-render. The subsystem switcher strip (shared core chrome) is injected on
 * render.
 */

import { MODULE_ID, ANSU, IZIR, SETTINGS, TEMPLATES } from "../../../core/constants.mjs";
import { readSubsystemFlag } from "../../../core/flags.mjs";
import { renderSubsystemSwitcher, applyHandoffPosition } from "../../../core/switcher.mjs";
import {
  readAnsu,
  patchAnsu,
  appendLog,
  listAttunedActors,
  isAttuned,
  attuneActor,
  unattuneActor,
} from "../state.mjs";
import { tierForLevel, climbNeeded, forkAllowed, MAX_LEVEL } from "../logic/model.mjs";
import {
  selectEntries,
  buildCtx,
  injectNumbers,
  durationLabel,
  communionMode,
  doorsDead,
  costGlyph,
  actionDataFor,
  ladderCtxLevel,
} from "../logic/reconcile.mjs";
import { dcDraftValue, rosterDots } from "../logic/panel.mjs";
import { seizeReturnsTo } from "../logic/seizure.mjs";
import { suggestChips } from "../logic/suggest.mjs";
import { loadContent } from "../content.mjs";
import { syncActor, syncAllAttuned, displayTier, readDials, inActiveCombat } from "../sync.mjs";
import { invokeCommunion, requestInvoke, endCommunion, findCommunionEffect, remainingRounds } from "../mechanics/communion.mjs";
import {
  callRelease,
  suggestedDC,
  recordReleaseOutcome,
  clearPendingRelease,
  dismissReleaseReroll,
  postUrge,
} from "../mechanics/release.mjs";
import { suggestedCallDC, recordCallOutcome, clearPendingCall, dismissCallReroll } from "../mechanics/call.mjs";
import { startSeizure, returnFromSeizure, isSeized } from "../mechanics/seizure.mjs";
import { exportLog } from "../journal.mjs";
import { triggerFork, triggerTaken, setAttunement, applyClimbChange } from "../transform.mjs";
import { openArtDialog, openHistoryDialog } from "./ansu-dialogs.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TIER_GROUPS = [
  { id: "trial", levels: [1, 2, 3] },
  { id: "discipline", levels: [4, 5, 6] },
  { id: "union", levels: [7, 8, 9] },
];

const resolveActor = (uuid) => (uuid ? fromUuidSync(uuid) : null);

function tierLabelFor(st) {
  return game.i18n.localize(`SHARDS.Ansu.Tier.${displayTier(st)}`);
}

/* ------------------------------------------------------------------ */
/* GM gate                                                             */
/* ------------------------------------------------------------------ */

/**
 * This is a GM dashboard: every control writes another character's subsystem
 * flags, and several of them (Seize, the terminals, Remove attunement) are
 * one-way. Only the scene-control button was ever gated. The module API —
 * `game.modules.get(...).api.openPanel("ansu")`, mirrored on
 * `globalThis.TheShardsSubsystems` — is defined on every client, so a player who
 * ran the launcher macro or typed one line in the console got the whole panel,
 * and Foundry then happily let them drive their OWN actor's attunement, Climb
 * and Communion, because they own it. Gated three times over: the entry point,
 * the render, and every action handler. (0.6.6)
 */
const isGM = () => game.user?.isGM === true;

function refuseNonGM() {
  ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.GmOnly"));
}

/** Wrap an action map so a hand-built click can never reach a mutation. */
function gmGuarded(actions) {
  return Object.fromEntries(
    Object.entries(actions).map(([name, handler]) => [
      name,
      function guarded(...args) {
        if (!isGM()) return refuseNonGM();
        return handler.apply(this, args);
      },
    ]),
  );
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
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.MarkedNone"));
    return;
  }
  let n = 0;
  let already = 0;
  for (const t of tokens) {
    const actor = t.actor;
    if (!actor) continue;
    if (isAttuned(actor)) {
      already += 1;
      this._actorUuid = actor.uuid;
      continue;
    }
    await attuneActor(actor);
    await appendLog(actor, "mark", {});
    await syncActor(actor);
    this._actorUuid = actor.uuid;
    n += 1;
  }
  if (n) ui.notifications?.info(game.i18n.format("SHARDS.Ansu.MarkedDone", { n }));
  else if (already) ui.notifications?.info(game.i18n.localize("SHARDS.Ansu.MarkedAlready"));
  else ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.MarkedNone"));
  this.render();
}

async function onUnmark(_event, target) {
  const actor = resolveActor(target.dataset.actor);
  if (!actor) return;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("SHARDS.Ansu.Unmark") },
    content: `<p>${game.i18n.format("SHARDS.Ansu.UnmarkConfirm", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
  }).catch(() => false);
  if (!ok) return;
  await patchAnsu(actor, { enabled: false });
  await syncActor(actor);
  await unattuneActor(actor);
  if (this._actorUuid === actor.uuid) this._actorUuid = null;
  this.render();
}

async function onLevelUp() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (st.terminal) return;
  if (st.level >= MAX_LEVEL - 1) {
    await triggerFork(actor);
  } else {
    await setAttunement(actor, st.level + 1);
  }
  this.render();
}

async function onLevelDown() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (st.terminal) return;
  await setAttunement(actor, st.level - 1);
  this.render();
}

async function onFork() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  // Mirror triggerFork's own gate so the panel never opens a dialog it can't
  // finish. Below attunement 9 the button and the ladder chip are disabled, so
  // this only catches a keyboard route or a stale render. (0.6.6)
  if (!forkAllowed(readAnsu(actor))) return;
  await triggerFork(actor);
  this.render();
}

async function onTaken() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await triggerTaken(actor);
  this.render();
}

async function onClimbPlus() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await applyClimbChange(actor, { delta: +1, source: "gm" });
  this.render();
}
async function onClimbMinus() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await applyClimbChange(actor, { delta: -1, source: "gm" });
  this.render();
}
async function onClimbSet(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const value = Number(target.dataset.value);
  if (!Number.isFinite(value)) return;
  const st = readAnsu(actor);
  // Clicking the first filled segment clears the bar; anything else sets to it.
  const set = value === 1 && (st.climb ?? 0) === 1 ? 0 : value;
  await applyClimbChange(actor, { set, source: "gm" });
  this.render();
}

async function onToggleSuppress(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const family = target.dataset.family;
  const st = readAnsu(actor);
  const has = st.suppressed.some((s) => s.id === family);
  const suppressed = has
    ? st.suppressed.filter((s) => s.id !== family)
    : [...st.suppressed, { id: family, reason: "", at: Date.now() }];
  await patchAnsu(actor, { suppressed });
  await appendLog(actor, "suppress", { id: family, on: !has });
  await syncActor(actor);
  this.render();
}

async function onEditReason(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const family = target.dataset.family;
  const st = readAnsu(actor);
  const rec = st.suppressed.find((s) => s.id === family);
  if (!rec) return;
  const reason = await promptText(rec.reason ?? "", "SHARDS.Ansu.ReasonPrompt");
  if (reason === null) return;
  const suppressed = st.suppressed.map((s) => (s.id === family ? { ...s, reason } : s));
  await patchAnsu(actor, { suppressed });
  await appendLog(actor, "suppress", { id: family, reason }, reason);
  this.render();
}

async function onInvoke() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await requestInvoke(actor); // posts the Call card (or toggles a master straight in)
  this.render();
}

async function onForceInvoke() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await clearPendingCall(actor);
  await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.ForceInvokeNote"));
  this.render();
}

async function onRecordCall(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await recordCallOutcome(actor, target.dataset.outcome, null);
  this.render();
}

async function onClearPendingCall() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await clearPendingCall(actor);
  this.render();
}

async function onReleaseSave() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (st.terminal === "subjugated") {
    await endCommunion(actor, { via: "mastery" });
    this.render();
    return;
  }
  const dcInput = this.element.querySelector('input[name="releaseDc"]');
  const reasonInput = this.element.querySelector('input[name="releaseReason"]');
  const dc = Number(dcInput?.value);
  const reason = String(reasonInput?.value ?? "").trim();
  if (!Number.isFinite(dc) || dc < 1) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.BadDc"));
    return;
  }
  this._reasonDraft = "";
  this._dcDraft = null;
  await callRelease(actor, dc, reason);
  this.render();
}

async function onEndNoSave() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  // endCommunion writes the history row itself; appending a second one here put
  // the same "Communion ended" line in twice at the same timestamp, because
  // describeEntry ignores `via`. The note rides on the one row now. (0.6.6)
  await endCommunion(actor, {
    via: "gm-override",
    note: game.i18n.localize("SHARDS.Ansu.EndNoSaveNote"),
  });
  this.render();
}

async function onSeize() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (isSeized(st)) {
    // A manual (GM) seizure restores the exact pre-seizure snapshot. An auto
    // seizure returned by hand must still land in its thenMode — otherwise an
    // out-of-combat Call crit-fail (thenMode "active") never delivers the
    // Communion the "Ansu comes anyway" beat promises. (B9) The button's tooltip
    // reads the same answer, so the two can't disagree. (0.6.6)
    const toMode = seizeReturnsTo(st);
    await returnFromSeizure(actor, toMode ? { toMode } : {});
  } else {
    await startSeizure(actor, { auto: false });
  }
  this.render();
}

async function onRecordOutcome(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await recordReleaseOutcome(actor, target.dataset.outcome, null);
  this.render();
}

async function onClearPending() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await clearPendingRelease(actor);
  this.render();
}

// A hero point rerolled a roll the module had already resolved. The capture
// applied nothing; record or ignore is the GM's answer. (0.6.6)

async function onRecordReroll() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (!st.rerollRelease) return;
  await recordReleaseOutcome(actor, st.rerollRelease.outcome, st.rerollRelease.total ?? null, { force: true });
  this.render();
}

async function onDismissReroll() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await dismissReleaseReroll(actor);
  this.render();
}

async function onRecordCallReroll() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const st = readAnsu(actor);
  if (!st.rerollCall) return;
  await recordCallOutcome(actor, st.rerollCall.outcome, st.rerollCall.total ?? null, { force: true });
  this.render();
}

async function onDismissCallReroll() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await dismissCallReroll(actor);
  this.render();
}

async function onChip(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  switch (target.dataset.chip) {
    case "suggestDiscipline": {
      const climb = this.element.querySelector(".ansu-climb");
      climb?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      climb?.classList.add("pulse");
      setTimeout(() => climb?.classList.remove("pulse"), 1600);
      return; // no re-render — keep the pulse visible
    }
    case "suggestUrge":
      await postUrge(actor);
      break;
    case "suggestSeized": {
      const comm = this.element.querySelector(".ansu-comm");
      comm?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      comm?.classList.add("pulse");
      setTimeout(() => comm?.classList.remove("pulse"), 1600);
      return;
    }
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
    await syncAllAttuned();
    ui.notifications?.info(game.i18n.localize("SHARDS.Ansu.ResyncAllDone"));
  } else {
    const actor = resolveActor(this._actorUuid);
    if (!actor) return;
    await syncActor(actor);
    ui.notifications?.info(game.i18n.format("SHARDS.Ansu.ResyncDone", { name: actor.name }));
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
        label: game.i18n.localize("SHARDS.Ansu.Set"),
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

function chipFor(entry, st, replacedIds, ctx, doorsClosed = false) {
  const suppressedRec = st.suppressed.find((s) => s.id === entry.family);
  const isActive = entry.form === "action" || entry.form === "strike";
  // At the Taken terminal the two door actions leave the sheet (composeActions
  // drops them), so the ladder must not go on offering them either. (0.6.6)
  const dead = doorsClosed && entry.door === true;
  let tag = null;
  if (entry.chipTag) tag = injectNumbers(entry.chipTag, ctx);
  else if (entry.form === "strike") tag = game.i18n.localize("SHARDS.Ansu.TagStrike");
  else if (entry.actionData?.perCommunion) tag = "1/communion";
  if (replacedIds.includes(entry.id)) tag = game.i18n.localize("SHARDS.Ansu.TagReplaced");
  if (dead) tag = game.i18n.localize("SHARDS.Ansu.TagDoorClosed");
  return {
    family: entry.family,
    name: entry.name,
    isActive,
    isAlways: Boolean(entry.always),
    isPassive: !isActive && !entry.always,
    // Third place the cost is read, after the sheet item and the Communion
    // effect's ability list: a subjugated master's Invoke is a free action in
    // all three or in none. (0.6.6)
    actionsGlyph: costGlyph(actionDataFor(entry, st)),
    tag,
    replaced: replacedIds.includes(entry.id),
    dead,
    suppressed: Boolean(suppressedRec),
    reason: suppressedRec?.reason ?? "",
  };
}

function buildLadder(st, content, charLevel, dials) {
  const { replacedIds } = selectEntries({ ...st, suppressed: [] }, content);
  const doorsClosed = doorsDead(communionMode(st));
  // One context per LEVEL, not one for the whole ladder: a locked row previews
  // its own unlock numbers while an unlocked row keeps the bearer's live ones.
  const cache = new Map();
  const ctxFor = (rowLevel) => {
    const at = ladderCtxLevel({ rowLevel, level: st.level });
    if (!cache.has(at)) cache.set(at, buildCtx(charLevel, at, dials));
    return cache.get(at);
  };
  const groups = TIER_GROUPS.map((g) => ({
    tierId: g.id,
    label: game.i18n.localize(`SHARDS.Ansu.Tier.${g.id}`),
    range: `${g.levels[0]}–${g.levels[g.levels.length - 1]}`,
    duration: durationLabel(g.id === "trial" ? 1 : g.id === "discipline" ? 3 : 10),
    rows: g.levels.map((lvl) => ({
      level: lvl,
      current: !st.terminal && st.level === lvl,
      locked: st.level < lvl,
      chips: content.entries
        .filter((e) => e.level === lvl && !e.gate)
        .sort((a, b) => Number(Boolean(a.always)) - Number(Boolean(b.always)) || a.id.localeCompare(b.id))
        .map((e) => chipFor(e, st, replacedIds, ctxFor(lvl), doorsClosed)),
    })),
  }));

  const gateChips = content.entries
    .filter((e) => e.gate === "subjugated")
    .map((e) => chipFor(e, st, replacedIds, ctxFor(e.level ?? MAX_LEVEL), doorsClosed));

  return { groups, gateChips };
}

function buildClimb(st, dials) {
  if (st.terminal || st.level < 1 || st.level >= MAX_LEVEL) return null;
  const needed = climbNeeded(st.level, dials.climbBase, dials.climbStep);
  const value = Math.min(st.climb ?? 0, needed);
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

/**
 * The one-line reroll notice: what was recorded against what the reroll says.
 * Rendered outside the pending block — by the time a hero point is spent the
 * pending marker is long gone. (0.6.6)
 */
function rerollView(rec) {
  if (!rec?.outcome) return null;
  const label = (o) => (o ? game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) : "—");
  return {
    outcome: rec.outcome,
    fromLabel: label(rec.from),
    toLabel: label(rec.outcome),
    total: Number.isFinite(rec.total) ? rec.total : null,
  };
}

function buildRelease(st, dcPreview) {
  const suggestionsOn = game.settings.get(MODULE_ID, SETTINGS.ANSU_SUGGESTIONS) === true;
  return {
    dc: dcPreview,
    subjugated: st.terminal === "subjugated",
    taken: st.terminal === "taken",
    pending: st.pendingRelease ? { ...st.pendingRelease } : null,
    reroll: rerollView(st.rerollRelease),
    outcomes: OUTCOMES.map((o) => ({ key: o, label: game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) })),
    chips: suggestChips(st.log, { enabled: suggestionsOn }).map((c) => ({
      chip: c.action,
      label: game.i18n.localize(c.labelKey),
    })),
    recent: st.log
      .filter((e) => e.type === "release")
      .slice(-4)
      .reverse()
      .map((e) => ({
        outcome: e.data?.outcome ?? "none",
        label: e.data?.outcome ? game.i18n.localize(`SHARDS.Ansu.OutcomeShort.${e.data.outcome}`) : "—",
        climb: e.data?.climbDelta > 0 ? `+${e.data.climbDelta}` : "±0",
      })),
  };
}

/** The Communion control-bar view model. */
function buildComm(actor, st) {
  const mode = communionMode(st);
  const seized = mode === "seized" || st.terminal === "taken";
  const running = mode !== "none" && mode !== "off";
  let rounds = null;
  if (mode === "active" && inActiveCombat(actor)) {
    const effect = findCommunionEffect(actor);
    if (effect) rounds = remainingRounds(effect);
  }
  const OUTCOME_KEYS = ["criticalSuccess", "success", "failure", "criticalFailure"];
  return {
    mode,
    modeLabel: game.i18n.localize(`SHARDS.Ansu.Mode.${mode === "none" || mode === "off" ? "dormant" : mode}`),
    rounds,
    // Null is "no countdown to show"; 0 is the final round, and the template
    // needs the two apart because {{#if 0}} is false. (0.6.6)
    hasRounds: rounds !== null,
    finalRound: rounds === 0,
    stamped: st.communion?.rounds ?? null,
    canInvoke: !running && st.terminal !== "taken" && (st.level >= 1 || st.terminal === "subjugated"),
    invokeIsCall: !st.terminal, // pre-Mastery the button posts the Call check
    pendingCall: st.pendingCall ? { ...st.pendingCall } : null,
    callReroll: rerollView(st.rerollCall),
    callOutcomes: OUTCOME_KEYS.map((o) => ({ key: o, label: game.i18n.localize(`SHARDS.Ansu.OutcomeShort.${o}`) })),
    canForceInvoke: !running && !st.terminal && st.level >= 1,
    canRelease: running && !seized && st.terminal !== "taken",
    releaseIsToggle: st.terminal === "subjugated",
    canEndNoSave: running && !st.terminal && mode !== "seized",
    showSeize: !st.terminal,
    seized: mode === "seized",
    seizeAuto: Boolean(st.seizure?.auto),
    // Where Return actually lands them, so the tooltip stops promising "the
    // exact pre-seizure state" for the two auto variants that never restore it.
    seizeReturnsTo: seizeReturnsTo(st),
  };
}

/* ------------------------------------------------------------------ */
/* The application                                                     */
/* ------------------------------------------------------------------ */

/** The action map, before the GM guard wraps every entry. */
const PANEL_ACTIONS = {
  selectActor: onSelectActor,
  markSelected: onMarkSelected,
  unmark: onUnmark,
  levelUp: onLevelUp,
  levelDown: onLevelDown,
  fork: onFork,
  taken: onTaken,
  climbPlus: onClimbPlus,
  climbMinus: onClimbMinus,
  climbSet: onClimbSet,
  toggleSuppress: onToggleSuppress,
  editReason: onEditReason,
  invoke: onInvoke,
  forceInvoke: onForceInvoke,
  recordCall: onRecordCall,
  clearPendingCall: onClearPendingCall,
  releaseSave: onReleaseSave,
  endNoSave: onEndNoSave,
  seize: onSeize,
  recordOutcome: onRecordOutcome,
  clearPending: onClearPending,
  recordReroll: onRecordReroll,
  dismissReroll: onDismissReroll,
  recordCallReroll: onRecordCallReroll,
  dismissCallReroll: onDismissCallReroll,
  chip: onChip,
  exportJournal: onExportJournal,
  resync: onResync,
  openArt: onOpenArt,
  openHistory: onOpenHistory,
};

export class AnsuPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  _actorUuid = null;
  // Which bearer the DC / reason boxes were typed for. The drafts are app-level
  // fields, so without this a DC typed for one bearer pre-filled every bearer
  // selected afterwards and overrode their own computed suggestion. (0.6.6)
  _draftUuid = null;
  _dcDraft = null;
  _reasonDraft = "";

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-ansu`,
    classes: [MODULE_ID, "ansu-panel-app"],
    tag: "div",
    window: { title: "SHARDS.Ansu.PanelTitle", icon: "fa-solid fa-hand-fist", resizable: true },
    position: { width: 960, height: 760 },
    actions: gmGuarded(PANEL_ACTIONS),
  };

  static PARTS = {
    main: { template: TEMPLATES.ANSU_PANEL },
  };

  /** Nothing renders this dashboard for a player, whatever opened it. */
  _canRender() {
    return isGM();
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    renderSubsystemSwitcher(this, ANSU);
    // Keep the release inputs alive across re-renders.
    const dcInput = this.element.querySelector('input[name="releaseDc"]');
    const reasonInput = this.element.querySelector('input[name="releaseReason"]');
    if (dcInput) {
      // An emptied box is not a draft: restoring "" here blanked the DC on every
      // render until a number was typed and the trigger pressed. (0.6.6)
      const restored = dcDraftValue({ draft: this._dcDraft, suggested: null });
      if (restored !== null) dcInput.value = restored;
      dcInput.addEventListener("input", () => (this._dcDraft = dcInput.value));
    }
    if (reasonInput) {
      if (this._reasonDraft) reasonInput.value = this._reasonDraft;
      reasonInput.addEventListener("input", () => (this._reasonDraft = reasonInput.value));
    }
  }

  async _prepareContext() {
    const attuned = listAttunedActors();
    if (this._actorUuid && !attuned.some((a) => a.uuid === this._actorUuid)) this._actorUuid = null;
    if (!this._actorUuid && attuned.length) this._actorUuid = attuned[0].uuid;

    // Five code paths reassign _actorUuid, so the drafts are invalidated here,
    // where the selection has finally settled, rather than in one handler.
    if (this._draftUuid !== this._actorUuid) {
      this._draftUuid = this._actorUuid;
      this._dcDraft = null;
      this._reasonDraft = "";
    }

    const roster = attuned.map((a) => {
      const st = readAnsu(a);
      const izirFlag = readSubsystemFlag(a, IZIR);
      return {
        uuid: a.uuid,
        name: a.name,
        img: a.img,
        level: st.level,
        tierId: displayTier(st),
        tierLabel: tierLabelFor(st),
        terminal: st.terminal,
        pending: Boolean(st.pendingRelease),
        ...rosterDots(st),
        dualIzir: Boolean(izirFlag) && izirFlag.enabled !== false,
        selected: a.uuid === this._actorUuid,
      };
    });

    const selected = attuned.find((a) => a.uuid === this._actorUuid) ?? null;
    let detail = null;
    let ladder = null;
    let climb = null;
    let release = null;
    let comm = null;
    if (selected) {
      const st = readAnsu(selected);
      const dials = readDials();
      const charLevel = Math.max(1, Number(selected.system?.details?.level?.value ?? selected.level ?? 1) || 1);
      const dcPreview = suggestedDC(st);
      detail = {
        uuid: selected.uuid,
        name: selected.name,
        img: selected.img,
        level: st.level,
        maxLevel: MAX_LEVEL,
        tierId: displayTier(st),
        tierLabel: tierLabelFor(st),
        terminal: st.terminal,
        releaseDc: st.terminal ? "—" : dcPreview,
        callDc: st.terminal ? "—" : suggestedCallDC(st),
        duration: st.terminal ? durationLabel(null) : durationLabel(st.level >= 1 ? (st.level <= 3 ? 1 : st.level <= 6 ? 3 : 10) : 0),
        suppressedCount: st.suppressed.length,
        canDown: st.level > 0 && !st.terminal,
        canUp: !st.terminal,
        atNinth: !st.terminal && st.level === MAX_LEVEL - 1,
      };
      detail.releaseDcDraft = dcDraftValue({ draft: this._dcDraft, suggested: dcPreview });
      const content = await loadContent().catch(() => null);
      if (content) ladder = buildLadder(st, content, charLevel, dials);
      climb = buildClimb(st, dials);
      release = buildRelease(st, dcPreview);
      comm = buildComm(selected, st);
    }

    const density = game.settings.get(MODULE_ID, SETTINGS.PANEL_DENSITY);
    return {
      hasRoster: roster.length > 0,
      roster,
      detail,
      ladder,
      climb,
      release,
      comm,
      densityClass: density === "compact" ? "compact" : "full",
    };
  }
}

let instance;

/** Open (or focus) the Ansu panel, optionally on an actor and at a handed-off position. */
export function openAnsuPanel(actorUuid, opts = {}) {
  // The module API reaches every client, so this is a real entry point for a
  // player, not just the GM's toolbar button. (0.6.6)
  if (!isGM()) {
    refuseNonGM();
    return;
  }
  instance ??= new AnsuPanel();
  if (actorUuid) instance._actorUuid = actorUuid;
  instance.render({ force: true });
  applyHandoffPosition(instance, opts);
}

/** Re-render the panel if it's open (e.g. after an actor flag changes elsewhere). */
export function refreshAnsuPanel() {
  if (instance?.rendered) instance.render();
}
