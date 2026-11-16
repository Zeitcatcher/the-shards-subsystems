/**
 * The release save: handing the borrowed strength back.
 *
 * GM (or the player's Release action, or the Communion running out) triggers a
 * Fortitude save: for a PC, a whispered chat card with an inline pf2e @Check the
 * player clicks; for an NPC the GM rolls directly. One createChatMessage capture
 * records the degree of success (0.8): every outcome ends Communion; a failure
 * costs Hit Points, a critical failure more Hit Points, Fatigued and a lockout
 * on the Call. No Lingering, no seizure, no Climb.
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "../state.mjs";
import { releaseDCFor, degreeOf, hpLoss, lockoutAfterRelease, makeLockout } from "../logic/model.mjs";
import {
  acceptReleaseRoll,
  acceptRerollCapture,
  rerollTransition,
  RELEASE_OPTION,
  RELEASE_ID_PREFIX,
} from "../logic/timing.mjs";
import { readDials } from "../sync.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** The default release DC for an actor: attunement plus the failed Call's +2. */
export function suggestedDC(state) {
  const d = readDials();
  return releaseDCFor(state.level, state.communion?.returnPenalty ?? 0, { base: d.dcBase, step: d.dcStep, cap: d.dcCap });
}

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/**
 * Start a Release save with a known DC and reason. Writes the pending marker,
 * then whispers the card (PC) or rolls (NPC). No-op for subjugated masters —
 * they end Communion at will. A fresh call REPLACES any stale pending Release
 * (new id, new card): an un-rolled card from an earlier scene must never wedge
 * the door shut — the same rule the Call got in v0.6.1.
 */
export async function callRelease(actor, dc, reason = "") {
  if (!actor || !Number.isFinite(dc)) return;
  const st = readAnsu(actor);
  if (st.terminal) return;
  const id = foundry.utils.randomID();
  await patchAnsu(actor, { pendingRelease: { id, dc, reason, createdAt: Date.now() } });

  const owners = playerOwners(actor);
  if (owners.length) await postReleaseCard(actor, id, dc, reason, owners);
  else await rollNpcRelease(actor, id, dc);
  refreshAnsuPanel();
}

/** PC path: a whispered card with an inline check the player clicks. */
async function postReleaseCard(actor, id, dc, reason, ownerIds) {
  const showDc = game.settings.get(MODULE_ID, SETTINGS.ANSU_SHOW_DC) || "gm";
  const name = game.i18n.localize("SHARDS.Ansu.ReleaseTitle");
  // roller:self — a SAVE has no fallback to the card's actor at all, so a clicker
  // with an enemy token selected rolled the enemy's save and one with nothing
  // selected got "No token selected" and could not roll. The card is whispered to
  // owners plus GMs, all of whom can update the actor, so nobody hits pf2e's
  // plain-text downgrade at text-editor.ts:722. (0.6.6)
  // Fortitude, no mental trait (0.8).
  const check = `@Check[fortitude|dc:${dc}|name:${name}|showDC:${showDc}|roller:self|options:${RELEASE_OPTION},${RELEASE_ID_PREFIX}${id}]`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...ownerIds, ...gmIds])];
  const penalty =
    readAnsu(actor).communion?.returnPenalty === 2
      ? `<p class="ansu-card-penalty">${esc(game.i18n.localize("SHARDS.Ansu.ReleasePenaltyLine"))}</p>`
      : "";
  const body = (reason ? `<p class="ansu-card-reason"><em>${esc(reason)}</em></p>` : "") + penalty;
  const content = `<div class="ansu-card">
    <p class="ansu-card-title"><i class="fa-solid fa-hand-fist"></i> ${game.i18n.localize("SHARDS.Ansu.ReleaseCardTitle")}</p>
    ${body}
    <p>${check}</p>
  </div>`;
  await ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** NPC path: GM rolls the Fortitude save directly; same tag → same capture. */
async function rollNpcRelease(actor, id, dc) {
  const fortitude = actor.getStatistic?.("fortitude") ?? actor.saves?.fortitude;
  if (!fortitude?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoFortitude"));
    await patchAnsu(actor, { pendingRelease: null }); // don't wedge the release block (C7)
    return;
  }
  await fortitude.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Ansu.ReleaseTitle"),
    extraRollOptions: [RELEASE_OPTION, `${RELEASE_ID_PREFIX}${id}`],
    // NOT rollMode: v14 renamed the concept and pf2e 8.5.0 has no such parameter
    // (Statistic#roll builds its context from an explicit object literal), so the
    // old key was dropped in silence and every NPC save went public.
    // "gm" is the CONFIG.ChatMessage.modes key pf2e itself writes. (0.6.6)
    messageMode: "gm",
  });
}

function resolveActor(message) {
  // pf2e's ChatMessage#actor (speakerActor) is scene/token aware and resolves
  // unlinked (synthetic) token actors. flags.pf2e.context.actor is only a bare
  // world-actor id, which misses them entirely. (B1)
  if (message.actor) return message.actor;
  const { scene, token, actor } = message.speaker ?? {};
  if (scene && token) {
    const t = game.scenes?.get(scene)?.tokens?.get(token);
    if (t?.actor) return t.actor;
  }
  return actor ? game.actors.get(actor) : null;
}

/** Register the createChatMessage capture. Primary GM only. Call on ready. */
export function registerReleaseHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | release capture`, err));
  });
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  const actor = resolveActor(message);
  if (!actor || !isAttuned(actor)) return;

  const st = readAnsu(actor);
  const pending = st.pendingRelease;
  const outcomeOf = ctx.outcome ?? null;
  if (!pending) {
    // No open Release, but this may still be OUR save: a hero point deletes the
    // rolled card and posts a new one from a deep clone of the context, so the
    // roll option and the card id are still there. (0.6.6)
    await noteReroll(actor, st, ctx, outcomeOf, message.rolls?.[0]?.total ?? null);
    return;
  }

  // Match on the injected roll option: present on both the player's card click
  // and the GM's NPC roll. Off-card rolls use the panel's manual recorder, so
  // there is no fuzzy DC/time fallback that could capture an unrelated save
  // (e.g. a Fortitude save vs a poison) at the same DC. (B2)
  // The card id decides which card was rolled, but a mismatch no longer throws
  // the roll away: a replaced or duplicated card still carries a real roll, and
  // dropping it left the pending marker open and the wrestle stuck. (0.6.5)
  const { accept, idMatch, rolledId } = acceptReleaseRoll({ options: ctx.options ?? [], pendingId: pending.id });
  if (!accept) return;
  if (!idMatch) {
    console.warn(
      `${MODULE_ID} | release roll for "${actor.name}" carries card id ${rolledId ?? "none"} but the open Release is ${pending.id} — recording it anyway (the card was replaced or duplicated).`,
    );
  }

  const total = message.rolls?.[0]?.total ?? null;
  await recordReleaseOutcome(actor, outcomeOf, total);
}

/**
 * A reroll of the release we already resolved. Nothing is applied here: the
 * costs of the recorded outcome have already landed, so the GM gets a card and
 * the panel gets a button. An unchanged outcome is not even worth mentioning.
 */
async function noteReroll(actor, st, ctx, outcome, total) {
  const last = st.lastRelease;
  const r = acceptRerollCapture({
    options: ctx.options ?? [],
    flagged: ctx.isReroll === true,
    last,
    now: Date.now(),
    outcome,
  });
  if (!r.accept) return;
  if (st.rerollRelease?.id === last.id && st.rerollRelease?.outcome === outcome) return; // already noticed

  await patchAnsu(actor, {
    rerollRelease: { id: last.id, from: last.outcome ?? null, outcome, total, at: Date.now() },
  });
  await whisperGM(
    actor,
    game.i18n.format("SHARDS.Ansu.RerollReleaseNotice", {
      name: actor.name,
      from: outcomeLabel(last.outcome),
      to: outcomeLabel(outcome),
    }),
  );
  refreshAnsuPanel();
}

/** A degree of success in words, or a dash when there isn't one. */
const outcomeLabel = (o) => (o ? game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) : "—");

/** GM-only card. Escaped here, at the choke point: no lang value carries markup. */
async function whisperGM(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${esc(text)}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/**
 * Write a release outcome to the log, clear the pending marker and the return
 * penalty, and apply the outcome (0.8): every degree ends Communion (a no-op
 * after a critically failed Call, which granted none); failure and critical
 * failure cost Hit Points; a critical failure adds Fatigued and the lockout.
 *
 * The communion import is deferred to call time: the modules form a cycle at
 * load otherwise.
 */
const recording = new Set();

export async function recordReleaseOutcome(actor, outcome, total = null, { force = false } = {}) {
  const st = readAnsu(actor);
  // `force` is the GM pressing "record the reroll": the pending marker was
  // cleared by the first roll, so the record it corrects stands in for it.
  const pending =
    st.pendingRelease ??
    (force && st.lastRelease
      ? { id: st.lastRelease.id, dc: st.lastRelease.dc ?? null, reason: "", createdAt: st.lastRelease.at }
      : null);
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending Release at once (a failure would otherwise cost HP twice). (C5)
  // The forced re-record is a second, separate pass over the same id. (0.6.6)
  const key = `${actorKey(actor)}:${pending.id}${force ? ":reroll" : ""}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await recordReleaseOutcomeInner(actor, st, pending, outcome, total, force);
  } finally {
    recording.delete(key);
  }
}

async function recordReleaseOutcomeInner(actor, st, pending, outcome, total, force = false) {
  const prevOutcome = force ? (st.rerollRelease?.from ?? st.lastRelease?.outcome ?? null) : null;
  // A correction is costed at the level the first roll was made at.
  const level = force && Number.isInteger(st.lastRelease?.level) ? st.lastRelease.level : st.level;
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "release",
      data: { id: pending.id, dc: pending.dc ?? null, outcome, total, ...(force ? { reroll: true } : {}) },
      note: pending.reason ?? "",
    },
  ];
  const patch = {
    log,
    pendingRelease: null,
    lastRelease: { id: pending.id, dc: pending.dc ?? null, outcome, level, at: Date.now() },
    // The failed Call's +2 is spent on this roll.
    communion: { returnPenalty: 0 },
  };
  if (force) patch.rerollRelease = null;
  await patchAnsu(actor, patch);

  if (force) {
    await applyRerollCorrection(actor, prevOutcome, outcome, level);
    refreshAnsuPanel();
    return;
  }

  const { endCommunion } = await import("./communion.mjs");
  await endCommunion(actor, { via: "release" });

  const degree = degreeOf(outcome);
  if (degree === null || degree >= 2) {
    refreshAnsuPanel();
    return;
  }
  const lost = await loseHitPoints(actor, hpLoss(level, degree));
  if (degree === 0) {
    await addFatigued(actor);
    await stampReleaseLockout(actor, level);
  }
  await whisperOwners(
    actor,
    game.i18n.format(degree === 0 ? "SHARDS.Ansu.ReleaseCritFailReport" : "SHARDS.Ansu.ReleaseFailReport", {
      name: actor.name,
      hp: lost,
      lockout: lockoutLabel(level),
    }),
  );
  refreshAnsuPanel();
}

/**
 * Settle a GM-recorded reroll (rerollTransition): a worse outcome adds its
 * further cost, a critical failure withdrawn lifts its lockout, and anything that
 * would have to be given back (Hit Points, Fatigued) is left to the GM.
 */
async function applyRerollCorrection(actor, prevOutcome, outcome, level) {
  const step = rerollTransition({ prevOutcome, outcome, level });
  const hp = step.hpExtra > 0 ? await loseHitPoints(actor, step.hpExtra) : 0;
  if (step.fatigue) await addFatigued(actor);
  if (step.lockout) await stampReleaseLockout(actor, level);
  if (step.liftLockout) await patchAnsu(actor, { lockout: null });
  const text = step.handFix ? "SHARDS.Ansu.RerollReleaseHandFix" : "SHARDS.Ansu.RerollReleaseApplied";
  await whisperGM(
    actor,
    game.i18n.format(text, { name: actor.name, from: outcomeLabel(prevOutcome), to: outcomeLabel(outcome), hp }),
  );
}

/**
 * Reduce Hit Points directly (not damage: temporary Hit Points and resistances
 * do not touch it), never below 1 (ruling after step C): the release hurts but
 * never knocks the bearer out. A bearer already at 0 stays there. Returns what
 * was actually taken.
 */
async function loseHitPoints(actor, amount) {
  const current = Number(actor.system?.attributes?.hp?.value);
  if (!(amount > 0) || !Number.isFinite(current)) return 0;
  const next = Math.max(Math.min(current, 1), current - amount);
  if (next !== current) await actor.update({ "system.attributes.hp.value": next });
  return current - next;
}

/** Fatigued through pf2e's own condition API, defensively. */
async function addFatigued(actor) {
  try {
    await actor.increaseCondition?.("fatigued");
  } catch (err) {
    console.warn(`${MODULE_ID} | could not auto-apply fatigued`, err);
  }
}

/** The release lockout for this level. It replaces a shorter Call lockout. */
async function stampReleaseLockout(actor, level) {
  const spec = lockoutAfterRelease(level);
  if (!spec) return;
  await patchAnsu(actor, { lockout: makeLockout(spec, game.time?.worldTime ?? 0) });
}

/** The lockout in words, for the critical failure line. */
function lockoutLabel(level) {
  const spec = lockoutAfterRelease(level);
  if (!spec) return "";
  if (spec.untilRest) return game.i18n.localize("SHARDS.Ansu.LockoutUntilRest");
  return game.i18n.format("SHARDS.Ansu.LockoutMinutes", { minutes: Math.round(spec.seconds / 60) });
}

/** A line the bearer's owners and the GM all see. Escaped here. */
async function whisperOwners(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${esc(text)}</p></div>`,
    whisper: [...new Set([...playerOwners(actor), ...gmIds])],
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Discard a pending release without recording an outcome. */
export async function clearPendingRelease(actor) {
  await patchAnsu(actor, { pendingRelease: null });
  refreshAnsuPanel();
}

/** Dismiss a captured reroll notice without applying it (the GM's call). */
export async function dismissReleaseReroll(actor) {
  await patchAnsu(actor, { rerollRelease: null });
  refreshAnsuPanel();
}

/** Chip action: whisper the Ansu's urge to the player + GM (Lingering flavor). */
export async function postUrge(actor) {
  const owners = playerOwners(actor);
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...owners, ...gmIds])];
  await ChatMessage.create({
    content: `<div class="ansu-card"><p class="ansu-card-title"><i class="fa-solid fa-hand-fist"></i> ${game.i18n.localize("SHARDS.Ansu.UrgeTitle")}</p><p><em>${game.i18n.localize("SHARDS.Ansu.UrgeText")}</em></p></div>`,
    whisper,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}
