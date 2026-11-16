/**
 * Ansu GM control panel — same one-screen anatomy as the approved Izir dashboard:
 * roster · identity · stats · Communion control bar · loyalty and wrath · ladder · Release
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
import { forkAllowed, durationRoundsFor, MAX_LEVEL } from "../logic/model.mjs";
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
import {
  dcDraftValue,
  rosterDots,
  loyaltyView,
  wrathView,
  deedEffect,
  lockoutView,
  shortTime,
  nextLevelRule,
  lengthsFor,
} from "../logic/panel.mjs";
import { seizureLanding, seizureKind } from "../logic/seizure.mjs";
import { SEVERITIES } from "../logic/conflict.mjs";
import { loadContent, loadDeeds } from "../content.mjs";
import { syncActor, syncAllAttuned, displayTier, readDials, inActiveCombat } from "../sync.mjs";
import {
  invokeCommunion,
  requestInvoke,
  endCommunion,
  findCommunionEffect,
  remainingRounds,
  isFatigued,
} from "../mechanics/communion.mjs";
import {
  callRelease,
  suggestedDC,
  recordReleaseOutcome,
  clearPendingRelease,
  dismissReleaseReroll,
} from "../mechanics/release.mjs";
import { suggestedCallDC, recordCallOutcome, clearPendingCall, dismissCallReroll } from "../mechanics/call.mjs";
import { startSeizure, returnFromSeizure, isSeized, letAnsuIn, canLetIn } from "../mechanics/seizure.mjs";
import {
  startConflict,
  suggestedConflictDC,
  recordConflictOutcome,
  clearPendingConflict,
  recordConflictReroll,
  dismissConflictReroll,
} from "../mechanics/conflict.mjs";
import { exportLog, deedEffectText, rebuildValuesPage } from "../journal.mjs";
import { recordDeed, adjustBar, restForNight } from "../mechanics/deeds.mjs";
import { triggerFork, triggerTaken, setAttunement } from "../transform.mjs";
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
 * and Foundry then happily let them drive their OWN actor's attunement, loyalty
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

async function onBar(bar, delta) {
  const actor = resolveActor(this._actorUuid);
  if (actor) await adjustBar(actor, bar, delta);
  this.render();
}
async function onLoyaltyPlus() {
  return onBar.call(this, "loyalty", +1);
}
async function onLoyaltyMinus() {
  return onBar.call(this, "loyalty", -1);
}
async function onWrathPlus() {
  return onBar.call(this, "wrath", +1);
}
async function onWrathMinus() {
  return onBar.call(this, "wrath", -1);
}

/** Apply the deed picked in the list, with the optional note. */
async function onRecordDeed() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const select = this.element.querySelector('select[name="deed"]');
  const noteInput = this.element.querySelector('input[name="deedNote"]');
  const id = String(select?.value ?? "");
  if (!id) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.DeedPickFirst"));
    return;
  }
  const note = String(noteInput?.value ?? "").trim();
  this._deedDraft = "";
  this._deedNoteDraft = "";
  const r = await recordDeed(actor, id, note);
  if (r?.leveled) {
    ui.notifications?.info(game.i18n.format("SHARDS.Ansu.DeedLeveled", { name: actor.name, level: r.level[1] }));
  }
  this.render();
}

async function onNightRest() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const r = await restForNight(actor);
  if (r) {
    const moved = r.wrath[0] !== r.wrath[1] || r.lockoutCleared || r.consentReset;
    ui.notifications?.info(
      game.i18n.format(moved ? "SHARDS.Ansu.NightRestDone" : "SHARDS.Ansu.NightRestNothing", {
        name: actor.name,
        from: r.wrath[0],
        to: r.wrath[1],
      }),
    );
  }
  this.render();
}

async function onOpenValues() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const entry = await rebuildValuesPage(actor);
  entry?.sheet?.render(true);
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
    // Hand back: the landing follows the takeover's kind (seizureLanding), the
    // same answer the button's tooltip reads. Out of combat this is the only way
    // a takeover ends. (0.8)
    await returnFromSeizure(actor, { via: "gm" });
  } else {
    await startSeizure(actor, { kind: "manual" });
  }
  this.render();
}

/** The GM opens a conflict of will: what the Ansu wants and how serious it is. */
async function onConflict() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
  const options = SEVERITIES.map(
    (sev) =>
      `<option value="${sev}">${esc(game.i18n.localize(`SHARDS.Ansu.Severity.${sev}`))} (DC ${suggestedConflictDC(actor, sev)})</option>`,
  ).join("");
  const content = `<div class="form-group"><label>${esc(game.i18n.localize("SHARDS.Ansu.ConflictWantLabel"))}</label>
    <input type="text" name="want" autofocus></div>
    <div class="form-group"><label>${esc(game.i18n.localize("SHARDS.Ansu.ConflictSeverityLabel"))}</label>
    <select name="severity">${options}</select></div>`;
  const data = await foundry.applications.api.DialogV2.input({
    window: { title: game.i18n.localize("SHARDS.Ansu.ConflictDialogTitle") },
    content,
    ok: { label: game.i18n.localize("SHARDS.Ansu.ConflictStart") },
    rejectClose: false,
  });
  if (!data) return;
  await startConflict(actor, { want: data.want ?? "", severity: data.severity ?? "minor" });
  this.render();
}

async function onLetIn() {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await letAnsuIn(actor);
  this.render();
}

async function onRecordConflict(_event, target) {
  const actor = resolveActor(this._actorUuid);
  if (!actor) return;
  await recordConflictOutcome(actor, target.dataset.outcome);
  this.render();
}

async function onClearPendingConflict() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await clearPendingConflict(actor);
  this.render();
}

async function onRecordConflictReroll() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await recordConflictReroll(actor);
  this.render();
}

async function onDismissConflictReroll() {
  const actor = resolveActor(this._actorUuid);
  if (actor) await dismissConflictReroll(actor);
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
    if (!cache.has(at)) cache.set(at, buildCtx(charLevel, at, dials, { loyalty: st.loyalty }));
    return cache.get(at);
  };
  const groups = TIER_GROUPS.map((g) => ({
    tierId: g.id,
    label: game.i18n.localize(`SHARDS.Ansu.Tier.${g.id}`),
    range: `${g.levels[0]}–${g.levels[g.levels.length - 1]}`,
    duration: lengthsText(g.levels[0]),
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

/** Loyalty and wrath bars, the deed picker and the next-level rule. */
function buildBars(st, deeds, charLevel) {
  if (st.terminal) return null;
  const loyalty = loyaltyView(st.loyalty);
  const wrath = wrathView(st.wrath);
  const rule = nextLevelRule(st, charLevel);
  return {
    loyalty: {
      ...loyalty,
      bandLabel: game.i18n.localize(`SHARDS.Ansu.LoyaltyBand.${loyalty.band}`),
      full: loyalty.value >= loyalty.max,
    },
    wrath: {
      ...wrath,
      bandLabel: game.i18n.localize(`SHARDS.Ansu.WrathBand.${wrath.band}`),
    },
    gate: rule.gate,
    nextLevelText: game.i18n.format(
      rule.atNinth ? "SHARDS.Ansu.NextLevelNinth" : rule.canRise ? "SHARDS.Ansu.NextLevelOpen" : "SHARDS.Ansu.NextLevelGated",
      { gate: rule.gate },
    ),
    deeds: (deeds?.picker ?? []).map((d) => ({
      id: d.id,
      label: `${d.label} (${deedEffectText(deedEffect(d))})`,
    })),
  };
}

/** One tier's Communion lengths as "F 1 round · S 3 rounds · CS 1 minute". */
function lengthsText(level) {
  const l = lengthsFor(level);
  const lbl = (k) => game.i18n.localize(`SHARDS.Ansu.OutcomeAbbr.${k}`);
  return `${lbl("f")} ${durationLabel(l.f)} · ${lbl("s")} ${durationLabel(l.s)} · ${lbl("cs")} ${durationLabel(l.cs)}`;
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
  return {
    dc: dcPreview,
    subjugated: st.terminal === "subjugated",
    taken: st.terminal === "taken",
    pending: st.pendingRelease ? { ...st.pendingRelease } : null,
    reroll: rerollView(st.rerollRelease),
    outcomes: OUTCOMES.map((o) => ({ key: o, label: game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) })),
    recent: st.log
      .filter((e) => e.type === "release")
      .slice(-4)
      .reverse()
      .map((e) => ({
        outcome: e.data?.outcome ?? "none",
        label: e.data?.outcome ? game.i18n.localize(`SHARDS.Ansu.OutcomeShort.${e.data.outcome}`) : "—",
      })),
  };
}

/** The running lockout as text ("until a night's rest", "4 min"), or null. */
function lockoutLabel(st) {
  const lo = lockoutView(st.lockout, game.time?.worldTime ?? 0);
  if (!lo) return null;
  return lo.untilRest ? game.i18n.localize("SHARDS.Ansu.LockoutUntilRest") : shortTime(lo.seconds);
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
  const fatigued = isFatigued(actor);
  const lockout = lockoutLabel(st);
  const pendingPenalty = st.communion?.returnPenalty === 2;
  return {
    mode,
    modeLabel: game.i18n.localize(`SHARDS.Ansu.Mode.${mode === "none" || mode === "off" ? "dormant" : mode}`),
    rounds,
    // Null is "no countdown to show"; 0 is the final round, and the template
    // needs the two apart because {{#if 0}} is false. (0.6.6)
    hasRounds: rounds !== null,
    finalRound: rounds === 0,
    stamped: st.communion?.rounds ?? null,
    // Out of combat nothing ticks: the row names the stamped length instead.
    stampedLabel: running && rounds === null && st.communion?.rounds ? durationLabel(st.communion.rounds) : null,
    // The release-time flags, shown only when they apply.
    pendingPenalty,
    fatigued,
    lockout,
    hasFlags: pendingPenalty || fatigued || Boolean(lockout),
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
    // The takeover's kind and where handing back lands, for the tooltip. (0.8)
    seizeKind: mode === "seized" ? seizureKind(st.seizure) : null,
    seizeLanding: seizureLanding(st),
    seizeKindLabel:
      mode === "seized" ? game.i18n.localize(`SHARDS.Ansu.TakeoverKind.${seizureKind(st.seizure) ?? "manual"}`) : "",
    seizeTurnsLeft: mode === "seized" ? (st.seizure?.turnsLeft ?? null) : null,
    canConflict: !st.terminal && mode !== "seized",
    canLetIn: canLetIn(st),
    pendingConflict: st.pendingConflict
      ? {
          ...st.pendingConflict,
          stageLabel: game.i18n.localize(`SHARDS.Ansu.ConflictStage.${st.pendingConflict.stage}`),
        }
      : null,
    conflictReroll: rerollView(st.rerollConflict),
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
  loyaltyPlus: onLoyaltyPlus,
  loyaltyMinus: onLoyaltyMinus,
  wrathPlus: onWrathPlus,
  wrathMinus: onWrathMinus,
  recordDeed: onRecordDeed,
  nightRest: onNightRest,
  openValues: onOpenValues,
  toggleSuppress: onToggleSuppress,
  editReason: onEditReason,
  invoke: onInvoke,
  forceInvoke: onForceInvoke,
  recordCall: onRecordCall,
  clearPendingCall: onClearPendingCall,
  releaseSave: onReleaseSave,
  endNoSave: onEndNoSave,
  seize: onSeize,
  conflict: onConflict,
  letIn: onLetIn,
  recordConflict: onRecordConflict,
  clearPendingConflict: onClearPendingConflict,
  recordConflictReroll: onRecordConflictReroll,
  dismissConflictReroll: onDismissConflictReroll,
  recordOutcome: onRecordOutcome,
  clearPending: onClearPending,
  recordReroll: onRecordReroll,
  dismissReroll: onDismissReroll,
  recordCallReroll: onRecordCallReroll,
  dismissCallReroll: onDismissCallReroll,
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
  _deedDraft = "";
  _deedNoteDraft = "";

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
    const deedSelect = this.element.querySelector('select[name="deed"]');
    const deedNote = this.element.querySelector('input[name="deedNote"]');
    if (deedSelect) {
      if (this._deedDraft) deedSelect.value = this._deedDraft;
      deedSelect.addEventListener("change", () => (this._deedDraft = deedSelect.value));
    }
    if (deedNote) {
      if (this._deedNoteDraft) deedNote.value = this._deedNoteDraft;
      deedNote.addEventListener("input", () => (this._deedNoteDraft = deedNote.value));
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
      this._deedDraft = "";
      this._deedNoteDraft = "";
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
    let bars = null;
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
        // The success length of the duration table; the full F / S / CS row sits in the tooltip.
        duration: st.terminal ? durationLabel(null) : durationLabel(durationRoundsFor(st.level, 2)),
        durationHint: !st.terminal && st.level >= 1 ? lengthsText(st.level) : "",
        suppressedCount: st.suppressed.length,
        canDown: st.level > 0 && !st.terminal,
        canUp: !st.terminal,
        atNinth: !st.terminal && st.level === MAX_LEVEL - 1,
      };
      detail.releaseDcDraft = dcDraftValue({ draft: this._dcDraft, suggested: dcPreview });
      const content = await loadContent().catch(() => null);
      if (content) ladder = buildLadder(st, content, charLevel, dials);
      const deeds = await loadDeeds().catch(() => null);
      bars = buildBars(st, deeds, charLevel);
      release = buildRelease(st, dcPreview);
      comm = buildComm(selected, st);
    }

    const density = game.settings.get(MODULE_ID, SETTINGS.PANEL_DENSITY);
    return {
      hasRoster: roster.length > 0,
      roster,
      detail,
      ladder,
      bars,
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
