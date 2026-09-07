/**
 * The Release save — the wrestle to hand the borrowed strength back.
 *
 * GM (or the player's Release action) triggers a check → for a PC, a whispered
 * chat card with an inline pf2e @Check the player clicks; for an NPC the GM rolls
 * directly. One createChatMessage capture records the degree of success:
 * clean release feeds the Climb (+1 / +2 crit), failure means Lingering, and a
 * critical failure hands the body to the GM for one round (the hard rule).
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "../state.mjs";
import { releaseDC, climbDeltaFor, climbNeeded } from "../logic/model.mjs";
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

/** The default Release DC for an actor's current attunement. */
export function suggestedDC(state) {
  const d = readDials();
  return releaseDC(state.level, d.dcBase, d.dcStep, d.dcCap);
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
  // with an enemy token selected rolled the enemy's Will and one with nothing
  // selected got "No token selected" and could not roll. The card is whispered to
  // owners plus GMs, all of whom can update the actor, so nobody hits pf2e's
  // plain-text downgrade at text-editor.ts:722. (0.6.6)
  const check = `@Check[will|dc:${dc}|traits:mental|name:${name}|showDC:${showDc}|roller:self|options:${RELEASE_OPTION},${RELEASE_ID_PREFIX}${id}]`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...ownerIds, ...gmIds])];
  const body = reason ? `<p class="ansu-card-reason"><em>${esc(reason)}</em></p>` : "";
  const content = `<div class="ansu-card">
    <p class="ansu-card-title"><i class="fa-solid fa-hand-fist"></i> ${game.i18n.localize("SHARDS.Ansu.ReleaseCardTitle")}</p>
    ${body}
    <p>${check}</p>
  </div>`;
  await ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** NPC path: GM rolls the save directly; same tag → same capture. */
async function rollNpcRelease(actor, id, dc) {
  const will = actor.getStatistic?.("will") ?? actor.saves?.will;
  if (!will?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoWill"));
    await patchAnsu(actor, { pendingRelease: null }); // don't wedge the release block (C7)
    return;
  }
  await will.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Ansu.ReleaseTitle"),
    extraRollOptions: [RELEASE_OPTION, `${RELEASE_ID_PREFIX}${id}`],
    // NOT rollMode: v14 renamed the concept and pf2e 8.5.0 has no such parameter
    // (Statistic#roll builds its context from an explicit object literal), so the
    // old key was dropped in silence and every NPC Will save went public.
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
 * A reroll of the Release we already resolved. Nothing is applied here: undoing
 * a recorded success means resurrecting a deleted effect and unpicking a Climb
 * that may have crossed a level threshold, so the GM gets a card and the panel
 * gets a button. An unchanged outcome is not even worth mentioning.
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
 * Write a release outcome to the log, clear the pending marker, and move the
 * state machine: clean release ends Communion and feeds the Climb (+1 / +2 crit);
 * failure lingers; critical failure hands the body to the GM for one round.
 *
 * Imports of communion/seizure/transform are deferred to call time — the three
 * modules form a cycle at load otherwise.
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
  // same pending Release at once (a crit would otherwise Climb twice). (C5)
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
  // A correction owes only the DIFFERENCE in Climb — the recorded outcome
  // already moved the bar. A negative difference is never taken back on its own:
  // the GM has the ± controls and may have spent the level. (0.6.6)
  const prevOutcome = force ? (st.rerollRelease?.from ?? st.lastRelease?.outcome ?? null) : null;
  const delta = Math.max(0, climbDeltaFor(outcome) - (force ? climbDeltaFor(prevOutcome) : 0));
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "release",
      data: { id: pending.id, dc: pending.dc ?? null, outcome, total, climbDelta: delta, ...(force ? { reroll: true } : {}) },
      note: pending.reason ?? "",
    },
  ];
  const patch = {
    log,
    pendingRelease: null,
    lastRelease: { id: pending.id, dc: pending.dc ?? null, outcome, at: Date.now() },
  };
  if (force) patch.rerollRelease = null;
  await patchAnsu(actor, patch);

  const { endCommunion, slipToLingering } = await import("./communion.mjs");

  if (force) {
    const step = rerollTransition({ mode: st.communion?.mode ?? "none", prevOutcome, outcome });
    if (step.returnBody) {
      // The recorded critical failure took the body, and the correction says it
      // never happened: restore the pre-seizure snapshot (the panel's Return for
      // a manual hold) rather than the seizure's own landing state, then let the
      // new outcome apply from there. Landing in `thenMode` would keep the
      // consequence of the outcome being thrown away. (0.6.6)
      const { returnFromSeizure } = await import("./seizure.mjs");
      await returnFromSeizure(actor, {});
    }
    if (step.blocked) {
      await whisperGM(
        actor,
        game.i18n.format("SHARDS.Ansu.RerollNoRestore", {
          name: actor.name,
          from: outcomeLabel(prevOutcome),
          to: outcomeLabel(outcome),
        }),
      );
      refreshAnsuPanel();
      return;
    }
  }

  if (outcome === "success" || outcome === "criticalSuccess") {
    await endCommunion(actor, { via: "release" });
    const { applyClimbChange } = await import("../transform.mjs");
    const r = await applyClimbChange(actor, { delta, source: "release" });
    // Report what LANDED. At attunement 9 the bar caps, so a clean release used
    // to whisper "+1: now 11 / 11" with nothing written and no log row. (0.6.6)
    if (r && (r.moved > 0 || r.atTenth)) await whisperClimbReport(actor, r.moved, r);
    if (r && r.moved !== delta) await correctLoggedClimb(actor, pending.id, r.moved);
  } else if (outcome === "criticalFailure") {
    const { startSeizure } = await import("./seizure.mjs");
    await startSeizure(actor, { auto: true });
  } else if (outcome === "failure") {
    await slipToLingering(actor);
  }
  refreshAnsuPanel();
}

/**
 * GM-only confirmation of the climb movement after a captured outcome. `moved`
 * is what actually landed, so a full bar at attunement 9 reports the tenth step
 * alone instead of claiming movement that was never written.
 */
async function whisperClimbReport(actor, moved, r) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const parts = [];
  if (moved > 0) {
    const d = readDials();
    const needed = climbNeeded(r.level, d.climbBase, d.climbStep);
    parts.push(game.i18n.format("SHARDS.Ansu.ClimbMoved", { delta: moved, value: r.climb, needed }));
    if (r.leveled) parts.push(game.i18n.format("SHARDS.Ansu.ClimbLeveled", { name: actor.name, level: r.level }));
  }
  if (r.atTenth) parts.push(game.i18n.format("SHARDS.Ansu.TenthReady", { name: actor.name }));
  if (!parts.length) return;
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${esc(parts.join(" "))}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/**
 * Correct the release row's `climbDelta` once the Climb has actually moved.
 *
 * The row has to be written before the transition — a crash halfway through must
 * still leave the outcome recorded — but the panel history and the journal export
 * both print that number, and at a capped bar it claimed a climb that never
 * happened. Only the one row for this card is touched. (0.6.6)
 */
async function correctLoggedClimb(actor, id, moved) {
  const log = [...readAnsu(actor).log];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const row = log[i];
    if (row?.type !== "release" || row.data?.id !== id) continue;
    if (row.data.climbDelta === moved) return;
    log[i] = { ...row, data: { ...row.data, climbDelta: moved } };
    await patchAnsu(actor, { log });
    return;
  }
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
