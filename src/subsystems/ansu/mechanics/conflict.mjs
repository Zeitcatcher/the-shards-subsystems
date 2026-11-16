/**
 * The conflict of will (0.8): the third check kind, beside the Call and the
 * release, with the same plumbing (pending marker, roll option tag, capture,
 * reroll window).
 *
 * The GM opens it from the panel with what the Ansu wants and a severity. The GM
 * gets a whispered card with the want and the DC; the bearer gets the checks, all
 * at conflictDC: an optional Persuade (Diplomacy or Intimidation), then the Will
 * save. The outcomes apply their auto deeds and, on a lost Will save, start a
 * takeover by the wrath band (seizure.mjs). A berserk takeover reuses the same
 * card kind for its turn-end Will check (stage "berserk").
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned } from "../state.mjs";
import { conflictDC, wrathBand } from "../logic/model.mjs";
import { acceptRerollCapture } from "../logic/timing.mjs";
import {
  CONFLICT_OPTION,
  CONFLICT_ID_PREFIX,
  PERSUADE_SKILLS,
  SEVERITIES,
  acceptConflictRoll,
  conflictResult,
  conflictRerollStep,
} from "../logic/conflict.mjs";
import { seizureKind } from "../logic/seizure.mjs";
import { recordDeeds } from "./deeds.mjs";
import { startSeizure, returnFromSeizure, isSeized } from "./seizure.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const charLevelOf = (actor) => Math.max(0, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 0) || 0);

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

const gmIds = () => ChatMessage.getWhisperRecipients("GM").map((u) => u.id);

/** GM-only card. Escaped here, at the choke point: no lang value carries markup. */
async function whisperGM(actor, lines) {
  const body = (Array.isArray(lines) ? lines : [lines]).map((l) => `<p>${esc(l)}</p>`).join("");
  await ChatMessage.create({
    content: `<div class="ansu-card">${body}</div>`,
    whisper: gmIds(),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** The conflict DC for this bearer now. */
export function suggestedConflictDC(actor, severity) {
  return conflictDC(charLevelOf(actor), severity, readAnsu(actor).wrath);
}

/**
 * GM entry point: open a conflict of will. `want` is what the Ansu wants (shown
 * to the GM only), `severity` one of minor / serious / betrayal. A fresh conflict
 * replaces a stale pending one. Refused at a terminal and while the Ansu already
 * holds the body.
 */
export async function startConflict(actor, { want = "", severity = "minor" } = {}) {
  if (!actor) return;
  const st = readAnsu(actor);
  if (st.terminal || isSeized(st)) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.ConflictBlocked"));
    return;
  }
  const sev = SEVERITIES.includes(severity) ? severity : "minor";
  const dc = conflictDC(charLevelOf(actor), sev, st.wrath);
  const id = foundry.utils.randomID();
  await patchAnsu(actor, {
    pendingConflict: { id, dc, stage: "persuade", want: String(want ?? ""), severity: sev, createdAt: Date.now() },
  });
  await appendLog(actor, "conflict", { on: true, dc, severity: sev }, String(want ?? ""));

  await whisperGM(actor, [
    game.i18n.format("SHARDS.Ansu.ConflictGMTitle", { name: actor.name }),
    game.i18n.format("SHARDS.Ansu.ConflictGMWant", { want: want || "?" }),
    game.i18n.format("SHARDS.Ansu.ConflictGMDC", {
      severity: game.i18n.localize(`SHARDS.Ansu.Severity.${sev}`),
      dc,
      wrath: st.wrath,
      band: game.i18n.localize(`SHARDS.Ansu.WrathBand.${wrathBand(st.wrath)}`),
    }),
  ]);

  const owners = playerOwners(actor);
  if (owners.length) await postCheckCard(actor, { id, dc, stage: "persuade" }, owners);
  else {
    // An NPC bearer has no one to argue for him: straight to the Will save.
    await patchAnsu(actor, { pendingConflict: { stage: "will" } });
    await rollNpc(actor, id, dc);
  }
  refreshAnsuPanel();
}

/** The inline check for one statistic, tagged for the capture. */
function inlineCheck(stat, dc, id, label) {
  const showDc = game.settings.get(MODULE_ID, SETTINGS.ANSU_SHOW_DC) || "gm";
  // roller:self, as on the Call and release cards: the clicker's selected token
  // must never roll in the bearer's place. (0.6.6)
  // The Will save is a battle of minds and carries the mental trait (ruling
  // after step D); Diplomacy and Intimidation keep their own traits.
  const traits = stat === "will" ? "|traits:mental" : "";
  return `@Check[${stat}|dc:${dc}${traits}|name:${label}|showDC:${showDc}|roller:self|options:${CONFLICT_OPTION},${CONFLICT_ID_PREFIX}${id}]`;
}

/**
 * The bearer's card. Stage "persuade" offers Diplomacy or Intimidation and the
 * Will save; "will" (after a failed persuasion) and "berserk" offer the save.
 */
async function postCheckCard(actor, { id, dc, stage }, ownerIds) {
  const title = game.i18n.localize("SHARDS.Ansu.ConflictTitle");
  const will = inlineCheck("will", dc, id, title);
  const lines = [];
  if (stage === "persuade") {
    const persuade = PERSUADE_SKILLS.map((s) => inlineCheck(s, dc, id, title)).join(" ");
    lines.push(`<p>${esc(game.i18n.localize("SHARDS.Ansu.ConflictPersuadeLine"))} ${persuade}</p>`);
    lines.push(`<p>${esc(game.i18n.localize("SHARDS.Ansu.ConflictWillLine"))} ${will}</p>`);
  } else if (stage === "berserk") {
    lines.push(`<p>${esc(game.i18n.localize("SHARDS.Ansu.BerserkCheckLine"))} ${will}</p>`);
  } else {
    lines.push(`<p>${esc(game.i18n.localize("SHARDS.Ansu.ConflictWillAfterLine"))} ${will}</p>`);
  }
  const key = stage === "berserk" ? "SHARDS.Ansu.BerserkCheckTitle" : "SHARDS.Ansu.ConflictCardTitle";
  const content = `<div class="ansu-card">
    <p class="ansu-card-title"><i class="fa-solid fa-hand-back-fist"></i> ${esc(game.i18n.localize(key))}</p>
    ${lines.join("\n    ")}
  </div>`;
  await ChatMessage.create({
    content,
    whisper: [...new Set([...ownerIds, ...gmIds()])],
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** NPC path: the GM rolls the Will save directly; same tag, same capture. */
async function rollNpc(actor, id, dc) {
  const will = actor.getStatistic?.("will") ?? actor.saves?.will;
  if (!will?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoWill"));
    await patchAnsu(actor, { pendingConflict: null });
    return;
  }
  await will.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Ansu.ConflictTitle"),
    traits: ["mental"],
    extraRollOptions: [CONFLICT_OPTION, `${CONFLICT_ID_PREFIX}${id}`],
    messageMode: "gm", // not rollMode (0.6.6)
  });
}

/** Post the Will save stage of an open conflict (after a failed persuasion). */
async function postWillStage(actor, pending) {
  await patchAnsu(actor, { pendingConflict: { ...pending, stage: "will" } });
  const owners = playerOwners(actor);
  if (owners.length) await postCheckCard(actor, { id: pending.id, dc: pending.dc, stage: "will" }, owners);
  else await rollNpc(actor, pending.id, pending.dc);
}

/**
 * The berserk takeover's turn-end check: a Will save at the conflict's DC; a
 * success hands the body back. Called by seizure.mjs at each bearer turn end.
 */
export async function postBerserkCheck(actor) {
  const st = readAnsu(actor);
  if (!isSeized(st) || seizureKind(st.seizure) !== "berserk") return;
  const dc = Number.isFinite(st.seizure.dc) ? st.seizure.dc : suggestedConflictDC(actor, "minor");
  const id = foundry.utils.randomID();
  const pending = { id, dc, stage: "berserk", want: "", severity: null, createdAt: Date.now() };
  await patchAnsu(actor, { pendingConflict: pending });
  const owners = playerOwners(actor);
  if (owners.length) await postCheckCard(actor, pending, owners);
  else await rollNpc(actor, id, dc);
  refreshAnsuPanel();
}

/* ------------------------------------------------------------------ */
/* Capture                                                              */
/* ------------------------------------------------------------------ */

function resolveActor(message) {
  // pf2e's ChatMessage#actor is scene/token aware and resolves unlinked token
  // actors; the speaker is the fallback. (B1)
  if (message.actor) return message.actor;
  const { scene, token, actor } = message.speaker ?? {};
  if (scene && token) {
    const t = game.scenes?.get(scene)?.tokens?.get(token);
    if (t?.actor) return t.actor;
  }
  return actor ? game.actors.get(actor) : null;
}

/** Register the createChatMessage capture. Primary GM only. Call on ready. */
export function registerConflictHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | conflict capture`, err));
  });
}

/** Which stage a roll of this type answers, given the open marker's stage, or null. */
export function stageForRoll(rollType, pendingStage) {
  if (rollType === "skill-check") return pendingStage === "persuade" ? "persuade" : null;
  if (rollType === "saving-throw") return pendingStage === "berserk" ? "berserk" : "will";
  return null;
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || (ctx.type !== "skill-check" && ctx.type !== "saving-throw")) return;
  const options = ctx.options ?? [];
  if (!options.includes(CONFLICT_OPTION)) return;
  const actor = resolveActor(message);
  if (!actor || !isAttuned(actor)) return;

  const st = readAnsu(actor);
  const pending = st.pendingConflict;
  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  if (!pending) {
    await noteReroll(actor, st, ctx, outcome, total);
    return;
  }
  const { accept, idMatch, rolledId } = acceptConflictRoll({ options, pendingId: pending.id });
  if (!accept) return;
  if (!idMatch) {
    console.warn(
      `${MODULE_ID} | conflict roll for "${actor.name}" carries card id ${rolledId ?? "none"} but the open conflict is ${pending.id}, recording it anyway.`,
    );
  }
  const stage = stageForRoll(ctx.type, pending.stage);
  if (!stage) return; // a persuasion clicked after it already failed
  await recordConflictOutcome(actor, outcome, total, { stage });
}

/**
 * A reroll of a conflict check already resolved: the GM gets a card and the
 * panel a button. Nothing applies until the GM records it.
 */
async function noteReroll(actor, st, ctx, outcome, total) {
  const last = st.lastConflict;
  const r = acceptRerollCapture({
    options: ctx.options ?? [],
    flagged: ctx.isReroll === true,
    tag: CONFLICT_OPTION,
    idPrefix: CONFLICT_ID_PREFIX,
    last,
    now: Date.now(),
    outcome,
  });
  if (!r.accept) return;
  if (st.rerollConflict?.id === last.id && st.rerollConflict?.outcome === outcome) return;
  await patchAnsu(actor, {
    rerollConflict: { id: last.id, stage: last.stage, from: last.outcome ?? null, outcome, total, at: Date.now() },
  });
  await whisperGM(
    actor,
    game.i18n.format("SHARDS.Ansu.RerollConflictNotice", {
      name: actor.name,
      from: outcomeLabel(last.outcome),
      to: outcomeLabel(outcome),
    }),
  );
  refreshAnsuPanel();
}

const outcomeLabel = (o) => (o ? game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) : "?");

/* ------------------------------------------------------------------ */
/* Outcomes                                                             */
/* ------------------------------------------------------------------ */

const recording = new Set();

/**
 * Turn a conflict outcome into state. `stage` defaults to the open marker's
 * (a persuade marker recorded by hand counts as persuasion). Guarded against a
 * double apply when the capture and the panel recorder fire together.
 */
export async function recordConflictOutcome(actor, outcome, total = null, { stage } = {}) {
  const st = readAnsu(actor);
  const pending = st.pendingConflict;
  if (!pending) return;
  const key = `${actorKey(actor)}:${pending.id}:${pending.stage}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await recordInner(actor, st, pending, stage ?? pending.stage, outcome, total);
  } finally {
    recording.delete(key);
  }
}

async function recordInner(actor, st, pending, stage, outcome, total) {
  const result = conflictResult({ stage, outcome, wrath: st.wrath });
  if (!result) return;
  await patchAnsu(actor, {
    pendingConflict: null,
    lastConflict: {
      id: pending.id,
      dc: pending.dc,
      stage,
      outcome,
      wrath: st.wrath,
      want: pending.want ?? "",
      at: Date.now(),
    },
    rerollConflict: null,
  });
  await appendLog(actor, "conflict", { id: pending.id, stage, dc: pending.dc, outcome, total }, pending.want ?? "");
  await applyResult(actor, pending, result);
  if (stage !== "berserk" || result.handBack) {
    await whisperGM(
      actor,
      game.i18n.format("SHARDS.Ansu.ConflictOutcomeReport", {
        name: actor.name,
        stage: game.i18n.localize(`SHARDS.Ansu.ConflictStage.${stage}`),
        outcome: outcomeLabel(outcome),
      }),
    );
  }
  refreshAnsuPanel();
}

/** Deeds first (the takeover's snapshot carries them), then the takeover or the next card. */
async function applyResult(actor, pending, result) {
  if (result.deeds.length) await recordDeeds(actor, result.deeds, pending.want ?? "");
  if (result.next === "will") await postWillStage(actor, pending);
  if (result.takeover) {
    await startSeizure(actor, {
      kind: result.takeover.kind,
      turnsLeft: result.takeover.turnsLeft,
      deed: result.takeover.deed,
      dc: pending.dc,
      conflictId: pending.id,
    });
  }
  if (result.handBack) await returnFromSeizure(actor, { via: "will" });
}

/**
 * The GM records a captured reroll (conflictRerollStep): new deeds land, a held
 * save turned lost starts its takeover, a lost save turned held hands the body
 * back with no deed while that takeover still runs, a persuasion turned failure
 * posts the Will save and a failure turned success drops it. What cannot be
 * taken back is left to the GM, who is told.
 */
export async function recordConflictReroll(actor) {
  const st = readAnsu(actor);
  const r = st.rerollConflict;
  const last = st.lastConflict;
  if (!r || !last || r.id !== last.id) return;
  const step = conflictRerollStep({ stage: r.stage, prevOutcome: r.from, outcome: r.outcome, wrath: last.wrath });
  await patchAnsu(actor, { rerollConflict: null, lastConflict: { outcome: r.outcome, at: Date.now() } });
  await appendLog(actor, "conflict", { id: r.id, stage: r.stage, dc: last.dc, outcome: r.outcome, total: r.total, reroll: true });

  let handFix = step.handFix;
  if (step.addDeeds.length) await recordDeeds(actor, step.addDeeds, last.want ?? "");
  const now = readAnsu(actor);
  if (step.undoTakeover) {
    if (isSeized(now) && now.seizure?.conflictId === r.id) await returnFromSeizure(actor, { deed: false, via: "reroll" });
    else handFix = true;
  }
  if (step.startTakeover) {
    const plan = step.startTakeover;
    const started = await startSeizure(actor, {
      kind: plan.kind,
      turnsLeft: plan.turnsLeft,
      deed: plan.deed,
      dc: last.dc,
      conflictId: r.id,
    });
    if (!started) handFix = true;
  }
  if (step.cancelWill && readAnsu(actor).pendingConflict?.id === r.id) await patchAnsu(actor, { pendingConflict: null });
  if (step.postWill) {
    await postWillStage(actor, { id: r.id, dc: last.dc, stage: "will", want: last.want ?? "", severity: null, createdAt: Date.now() });
  }
  if (step.handBack) {
    const cur = readAnsu(actor);
    if (isSeized(cur) && seizureKind(cur.seizure) === "berserk") await returnFromSeizure(actor, { via: "reroll" });
    else handFix = true;
  }
  await whisperGM(
    actor,
    game.i18n.format(handFix ? "SHARDS.Ansu.RerollConflictHandFix" : "SHARDS.Ansu.RerollConflictApplied", {
      name: actor.name,
      from: outcomeLabel(r.from),
      to: outcomeLabel(r.outcome),
    }),
  );
  refreshAnsuPanel();
}

/** Dismiss a captured conflict reroll without applying it. */
export async function dismissConflictReroll(actor) {
  await patchAnsu(actor, { rerollConflict: null });
  refreshAnsuPanel();
}

/** Discard an open conflict card without recording an outcome. */
export async function clearPendingConflict(actor) {
  await patchAnsu(actor, { pendingConflict: null });
  refreshAnsuPanel();
}

