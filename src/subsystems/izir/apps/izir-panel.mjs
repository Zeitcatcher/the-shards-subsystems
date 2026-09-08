/**
 * Izir GM control panel — the approved one-screen dashboard. No tabs: the level
 * ladder IS the interface (suppress / reveal / reason act directly on its chips),
 * the slide bar and the temptation block are always visible, and Art / History
 * open as satellite dialogs. Actors are keyed by UUID so unlinked token actors
 * work. Every mutation goes flags → syncActor → re-render.
 */

import { MODULE_ID, IZIR, SETTINGS, TEMPLATES } from "../../../core/constants.mjs";
import { renderSubsystemSwitcher, applyHandoffPosition } from "../../../core/switcher.mjs";
import { isGM, refuseNonGM, gmGuarded } from "../../../core/gm.mjs";
import {
  readIzir,
  patchIzir,
  appendLog,
  listMarkedActors,
  isMarked,
  markActor,
  unmarkActor,
  withActorLock,
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
} from "../mechanics/temptation.mjs";
import { exportLog } from "../journal.mjs";
import { revertArt } from "../art.mjs";
import { triggerFork, setImmersion, applySlideChange } from "../transform.mjs";
import { openArtDialog, openHistoryDialog } from "./izir-dialogs.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TIER_GROUPS = [
  { id: "whisper", levels: [1, 2, 3] },
  { id: "grip", levels: [4, 5, 6] },
  { id: "call", levels: [7, 8, 9] },
];

const resolveActor = (uuid) => (uuid ? fromUuidSync(uuid) : null);

/**
 * Resolve the selected actor, or tell the GM why nothing happened. Deleting the
 * selected unlinked token left a dashboard whose every button failed in silence
 * until the GM happened to click another roster row. (F28)
 */
function requireActor(app) {
  const actor = resolveActor(app._actorUuid);
  if (!actor) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.SelectionGone"));
    app._actorUuid = null;
    app.render();
  }
  return actor;
}

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
    content: `<p>${game.i18n.format("SHARDS.Izir.UnmarkConfirm", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
  }).catch(() => false);
  if (!ok) return;
  // Put the original portrait and token back BEFORE the flag goes. The captured
  // originals live inside that flag namespace, and unmark really deletes it now,
  // so a swapped-art actor left un-reverted here keeps the corrupted portrait
  // with no record of what it used to be.
  await revertArt(actor);
  await patchIzir(actor, { enabled: false });
  await syncActor(actor);
  await unmarkActor(actor);
  if (this._actorUuid === actor.uuid) this._actorUuid = null;
  this.render();
}

async function onLevelUp() {
  const actor = requireActor(this);
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
  const actor = requireActor(this);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return;
  await setImmersion(actor, st.level - 1);
  this.render();
}

async function onFork(_event, target) {
  const actor = requireActor(this);
  if (!actor) return;
  const st = readIzir(actor);
  if (st.terminal) return;
  // A ladder chip names the fate it stands for; the stepper button offers both. (F13)
  await triggerFork(actor, target?.dataset?.path ?? null);
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
  const actor = requireActor(this);
  if (!actor) return;
  const family = target.dataset.family;
  // Locked: two toggles on different families inside one round trip used to
  // clobber each other's array and leave an ability live that the GM believed
  // suppressed. (F18)
  await withActorLock(actor, async () => {
    const st = readIzir(actor);
    const has = st.suppressed.some((x) => x.id === family);
    const suppressed = has
      ? st.suppressed.filter((x) => x.id !== family)
      : [...st.suppressed, { id: family, reason: "", at: Date.now() }];
    await patchIzir(actor, { suppressed });
    await appendLog(actor, "suppress", { id: family, on: !has });
  });
  await syncActor(actor);
  this.render();
}

async function onEditReason(_event, target) {
  const actor = requireActor(this);
  if (!actor) return;
  const family = target.dataset.family;
  const rec = readIzir(actor).suppressed.find((x) => x.id === family);
  if (!rec) return;
  const reason = await promptText(rec.reason ?? "", "SHARDS.Izir.ReasonPrompt");
  if (reason === null) return;
  await withActorLock(actor, async () => {
    const st = readIzir(actor);
    const suppressed = st.suppressed.map((x) => (x.id === family ? { ...x, reason } : x));
    await patchIzir(actor, { suppressed });
    // Its own entry type. Rewording a reason used to write another "Suppressed X"
    // line, so a history with three of them and no restore between read as three
    // separate suppressions. (F22)
    await appendLog(actor, "reason", { id: family }, reason);
  });
  this.render();
}

async function onToggleReveal(_event, target) {
  const actor = requireActor(this);
  if (!actor) return;
  const family = target.dataset.family;
  await withActorLock(actor, async () => {
    const st = readIzir(actor);
    const has = st.revealed.includes(family);
    const revealed = has ? st.revealed.filter((f) => f !== family) : [...st.revealed, family];
    await patchIzir(actor, { revealed });
    await appendLog(actor, "reveal", { id: family, on: !has });
  });
  await syncActor(actor);
  this.render();
}

async function onTempt() {
  const actor = requireActor(this);
  if (!actor) return;
  const dcInput = this.element.querySelector('input[name="temptDc"]');
  const reasonInput = this.element.querySelector('input[name="temptReason"]');
  const dc = Number(dcInput?.value);
  const reason = String(reasonInput?.value ?? "").trim();
  if (!Number.isFinite(dc) || dc < 1) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.BadDc"));
    return;
  }
  this._reasonDrafts.delete(actor.uuid);
  this._dcDrafts.delete(actor.uuid);
  await callTemptation(actor, dc, reason);
  this.render();
}

async function onRecordOutcome(_event, target) {
  const actor = requireActor(this);
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
  const actor = requireActor(this);
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
  // Re-sync is the "something is wrong, rebuild it" button, so it forces: the
  // content hash only covers what we compose, and an item can be stale in ways
  // the hash cannot see. It also reports what actually moved rather than always
  // claiming success. (F9)
  if (event?.shiftKey) {
    const n = await syncAllMarked({ force: true });
    if (n === null) {
      // Only the active GM writes to every marked actor; this used to report
      // success after bailing on that check. (F27)
      ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.ResyncNotPrimary"));
    } else {
      ui.notifications?.info(
        n ? game.i18n.format("SHARDS.Izir.ResyncAllDone", { n }) : game.i18n.localize("SHARDS.Izir.ResyncNoChange"),
      );
    }
  } else {
    const actor = resolveActor(this._actorUuid);
    if (!actor) return;
    const n = await syncActor(actor, { force: true });
    ui.notifications?.info(
      n
        ? game.i18n.format("SHARDS.Izir.ResyncDone", { name: actor.name, n })
        : game.i18n.localize("SHARDS.Izir.ResyncNoChange"),
    );
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

function chipFor(entry, st, replacedIds, transparency, ctx, familyNames) {
  const suppressedRec = st.suppressed.find((s) => s.id === entry.family);
  const isBane = entry.kind === "bane";
  const isActive = entry.form === "action" || entry.form === "strike";
  const replaced = replacedIds.includes(entry.id);
  // A capstone is locked only until subjugation actually happens. Afterwards it is
  // a live ability like any other and gets its cost, its tag and its controls --
  // they were the only entries on the ladder the GM could not suppress. (F21)
  const gateLocked = entry.gate === "subjugated" && st.terminal !== "subjugated";

  let tag = null;
  if (gateLocked) tag = game.i18n.localize("SHARDS.Izir.UnlockSubjugation");
  else if (entry.chipTag) tag = injectNumbers(entry.chipTag, ctx);
  else if (entry.form === "strike") tag = game.i18n.localize("SHARDS.Izir.TagStrike");
  else if (entry.actionData?.recharge) tag = `R ${entry.actionData.recharge}`;
  else if (entry.actionData?.frequency?.per === "day") tag = "1/day";
  if (replaced) tag = game.i18n.format("SHARDS.Izir.TagReplaced", { rank: "" }).trim();

  const nActions = entry.actionData?.actions ?? 0;
  const siblings = familyNames?.get(entry.family) ?? [entry.name];
  return {
    family: entry.family,
    name: entry.name,
    isBane,
    isActive,
    isPassive: !isBane && !isActive,
    actionsGlyph: isActive && nActions ? "◆".repeat(nActions) : "",
    tag,
    replaced,
    // Suppression works on the family, so the ban button on a greyed "replaced"
    // rank silently takes the LIVE rank off the sheet too. Say so on the button. (F21)
    suppressTip:
      siblings.length > 1
        ? game.i18n.format("SHARDS.Izir.SuppressFamily", { names: siblings.join(", ") })
        : null,
    gateLocked,
    suppressed: Boolean(suppressedRec),
    reason: suppressedRec?.reason ?? "",
    revealed: !isBane || transparency || st.revealed.includes(entry.family),
    showEye: isBane && !transparency,
  };
}

function buildLadder(st, content, transparency, charLevel) {
  const { replacedIds } = selectEntries({ ...st, suppressed: [] }, content);
  const ctx = buildCtx(charLevel, Math.max(1, st.level));

  // Every rank in a family, so a chip can name what suppressing it would take.
  const familyNames = new Map();
  for (const e of content.entries) {
    if (!familyNames.has(e.family)) familyNames.set(e.family, []);
    familyNames.get(e.family).push(e.name);
  }
  const chip = (e) => chipFor(e, st, replacedIds, transparency, ctx, familyNames);

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
        .map(chip),
    })),
  }));

  const gateChips = content.entries.filter((e) => e.gate === "subjugated").map(chip);

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

const GM_ONLY = "SHARDS.Izir.GmOnly";

const PANEL_ACTIONS = {
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
};

export class IzirPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  _actorUuid = null;
  // Keyed by actor uuid: a DC typed for one Nameless used to follow the GM to the
  // next one in the roster and quietly overwrite its suggested DC. (F11)
  _dcDrafts = new Map();
  _reasonDrafts = new Map();

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-izir`,
    classes: [MODULE_ID, "izir-panel-app"],
    tag: "div",
    window: { title: "SHARDS.Izir.PanelTitle", icon: "fa-solid fa-eye", resizable: true },
    position: { width: 960, height: 760 },
    actions: gmGuarded(PANEL_ACTIONS, GM_ONLY),
  };

  static PARTS = {
    // Named scroll containers survive a re-render; without them every level nudge
    // or suppression toggle threw the GM back to the top of a long ladder. (F17)
    main: { template: TEMPLATES.IZIR_PANEL, scrollable: [".izir-dash", ".izir-roster-list"] },
  };

  /** Nothing renders this dashboard for a player, whatever opened it. */
  _canRender() {
    return isGM();
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    renderSubsystemSwitcher(this, IZIR);
    // Keep the temptation inputs alive across re-renders.
    const uuid = this._actorUuid;
    const dcInput = this.element.querySelector('input[name="temptDc"]');
    const reasonInput = this.element.querySelector('input[name="temptReason"]');
    if (dcInput && uuid) {
      const draft = this._dcDrafts.get(uuid);
      if (draft) dcInput.value = draft;
      dcInput.addEventListener("input", () => {
        // An emptied field is no draft at all, so the suggested DC comes back
        // rather than the box staying blank.
        const v = dcInput.value.trim();
        if (v) this._dcDrafts.set(uuid, v);
        else this._dcDrafts.delete(uuid);
      });
    }
    if (reasonInput && uuid) {
      const draft = this._reasonDrafts.get(uuid);
      if (draft) reasonInput.value = draft;
      reasonInput.addEventListener("input", () => {
        const v = reasonInput.value;
        if (v) this._reasonDrafts.set(uuid, v);
        else this._reasonDrafts.delete(uuid);
      });
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
    let contentError = false;
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
      detail.temptDc = this._dcDrafts.get(selected.uuid) ?? dcPreview;
      const content = await loadContent().catch(() => null);
      const transparency = game.settings.get(MODULE_ID, SETTINGS.IZIR_TRANSPARENCY) === true;
      // A consumed character has no kit left. Ten unlocked rows of live ban and
      // eye buttons over abilities that no longer exist was worse than nothing;
      // the terminal banner already says what happened. (F21)
      if (content && st.terminal !== "nineveh") ladder = buildLadder(st, content, transparency, charLevel);
      // With a broken data file the panel used to look like a working screen --
      // no ladder, but a live fork button that would commit a terminal the module
      // could not finish. Say it plainly. (F30)
      contentError = !content;
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
      contentError,
      densityClass: density === "compact" ? "compact" : "full",
    };
  }
}

let instance;

/** Open (or focus) the Izir panel, optionally on an actor and at a handed-off position. */
export function openIzirPanel(actorUuid, opts = {}) {
  // The module API reaches every client, so this is a real entry point for a
  // player, not just the GM's toolbar button.
  if (!isGM()) {
    refuseNonGM(GM_ONLY);
    return;
  }
  instance ??= new IzirPanel();
  if (actorUuid) instance._actorUuid = actorUuid;
  instance.render({ force: true });
  applyHandoffPosition(instance, opts);
}

/** Re-render the panel if it's open (e.g. after an actor flag changes elsewhere). */
export function refreshIzirPanel() {
  if (instance?.rendered) instance.render();
}
