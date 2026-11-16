/**
 * The Call: the Athletics gate on Invoking the Ansu (attunement 1-9).
 *
 * The power is never owed: to summon it the bearer must show strength. Invoke
 * posts a whispered chat card with an inline pf2e @Check (Athletics vs the Call
 * DC: 20 + 2 x attunement, moved by the loyalty band); one createChatMessage
 * capture turns the degree of success into state (0.8):
 *   crit success: Communion at the longest length for the tier
 *   success:      Communion at the middle length
 *   failure:      Communion at the shortest length, release DC +2
 *   crit failure: no Communion, a 1-minute lockout, and the release card at once
 * The length is stamped into `communion.rounds`; the sync reads that stamp.
 * Subjugated masters skip the Call entirely (free toggle); the GM's force-invoke
 * bypasses it when the story says so.
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "../state.mjs";
import {
  callDCFor,
  callAdjust,
  loyaltyBand,
  durationRoundsFor,
  degreeOf,
  makeLockout,
  CALL_CF_LOCKOUT,
} from "../logic/model.mjs";
import { durationLabel } from "../logic/reconcile.mjs";
import {
  acceptCallRoll,
  acceptRerollCapture,
  callRerollTransition,
  CALL_OPTION,
  CALL_ID_PREFIX,
} from "../logic/timing.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** A degree of success in words, or a dash when there isn't one. */
const outcomeLabel = (o) => (o ? game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) : "—");

/** The default Call DC for an actor's attunement and loyalty (settings dials). */
export function suggestedCallDC(state) {
  const base = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_BASE));
  const step = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_STEP));
  return callDCFor(state.level, state.loyalty, {
    base: Number.isFinite(base) ? base : 20,
    step: Number.isFinite(step) ? step : 2,
  });
}

/** "Loyalty: wary, Call DC +0." The card's line naming the band and its DC move. */
export function loyaltyLine(loyalty) {
  const adj = callAdjust(loyalty);
  return game.i18n.format("SHARDS.Ansu.CallLoyaltyLine", {
    band: game.i18n.localize(`SHARDS.Ansu.LoyaltyBand.${loyaltyBand(loyalty)}`),
    adjust: adj < 0 ? String(adj) : `+${adj}`,
  });
}

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/**
 * Start the Call: write the pending marker, then whisper the card (PC) or roll
 * (NPC). A fresh Call REPLACES any stale pending one (new id, new card) — an
 * unrolled card from a past fight must never wedge the door shut.
 */
export async function callTheCall(actor, dc) {
  if (!actor || !Number.isFinite(dc)) return;
  const st = readAnsu(actor);
  if (st.terminal) return;
  const id = foundry.utils.randomID();
  await patchAnsu(actor, { pendingCall: { id, dc, createdAt: Date.now() } });

  const owners = playerOwners(actor);
  if (owners.length) await postCallCard(actor, id, dc, owners);
  else await rollNpcCall(actor, id, dc);
  refreshAnsuPanel();
}

/** PC path: a whispered card with an inline Athletics check the player clicks. */
async function postCallCard(actor, id, dc, ownerIds) {
  const showDc = game.settings.get(MODULE_ID, SETTINGS.ANSU_SHOW_DC) || "gm";
  const name = game.i18n.localize("SHARDS.Ansu.CallTitle");
  // roller:self — without it pf2e rolls for whatever token the clicker has
  // selected and only falls back to the card's actor when nothing is (an enemy
  // selected, and the GM rolls the enemy's skill). The card is whispered
  // to owners plus GMs, all of whom can update the actor, so nobody hits pf2e's
  // plain-text downgrade at text-editor.ts:722. (0.6.6)
  const check = `@Check[athletics|dc:${dc}|name:${name}|showDC:${showDc}|roller:self|options:${CALL_OPTION},${CALL_ID_PREFIX}${id}]`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...ownerIds, ...gmIds])];
  const content = `<div class="ansu-card">
    <p class="ansu-card-title"><i class="fa-solid fa-hand-fist"></i> ${game.i18n.localize("SHARDS.Ansu.CallCardTitle")}</p>
    <p class="ansu-card-reason"><em>${esc(game.i18n.localize("SHARDS.Ansu.CallFlavor"))}</em></p>
    <p class="ansu-card-loyalty">${esc(loyaltyLine(readAnsu(actor).loyalty))}</p>
    <p>${check}</p>
  </div>`;
  await ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** NPC path: GM rolls Athletics directly; same tag → same capture. */
async function rollNpcCall(actor, id, dc) {
  const athletics = actor.getStatistic?.("athletics") ?? actor.skills?.athletics;
  if (!athletics?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoAthletics"));
    await patchAnsu(actor, { pendingCall: null });
    return;
  }
  await athletics.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Ansu.CallTitle"),
    extraRollOptions: [CALL_OPTION, `${CALL_ID_PREFIX}${id}`],
    // NOT rollMode: v14 renamed the concept and pf2e 8.5.0 has no such parameter
    // (Statistic#roll builds its context from an explicit object literal), so the
    // old key was dropped in silence and every hidden NPC's Call went public.
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
export function registerCallHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | call capture`, err));
  });
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "skill-check") return;
  const actor = resolveActor(message);
  if (!actor || !isAttuned(actor)) return;

  const st = readAnsu(actor);
  const pending = st.pendingCall;
  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  if (!pending) {
    // No open Call, but a hero point reroll posts a NEW message built from a deep
    // clone of the first roll's context, so our option and card id are still on
    // it. The first roll cleared the marker, so nothing else would look. (0.6.6)
    await noteReroll(actor, st, ctx, outcome, total);
    return;
  }

  // Match on the injected roll option: present on both the player's card click
  // and the GM's NPC roll. Off-card rolls use the panel's manual recorder, so
  // there is no fuzzy DC/time fallback that could capture an unrelated skill
  // check (e.g. a Climb check) at the same DC. (B2)
  // The card id decides which card was rolled, but a mismatch is no longer
  // thrown away: before 0.8 requestInvoke REPLACED a stale pending Call, and a
  // card posted then is still reachable; rolling it must not spend the action
  // for nothing. Same rule the Release got in 0.6.5. (0.6.6)
  const { accept, idMatch, rolledId } = acceptCallRoll({ options: ctx.options ?? [], pendingId: pending.id });
  if (!accept) return;
  if (!idMatch) {
    console.warn(
      `${MODULE_ID} | Call check for "${actor.name}" carries card id ${rolledId ?? "none"} but the open Call is ${pending.id} — recording it anyway (the card was replaced or duplicated).`,
    );
  }

  await recordCallOutcome(actor, outcome, total);
}

/**
 * A reroll of the Call we already resolved. Nothing is applied: a recorded
 * critical failure has its lockout and release card, a recorded grant has a
 * Communion the table has been playing under. The GM gets a card and the panel
 * gets a button.
 */
async function noteReroll(actor, st, ctx, outcome, total) {
  const last = st.lastCall;
  const r = acceptRerollCapture({
    options: ctx.options ?? [],
    flagged: ctx.isReroll === true,
    tag: CALL_OPTION,
    idPrefix: CALL_ID_PREFIX,
    last,
    now: Date.now(),
    outcome,
  });
  if (!r.accept) return;
  if (st.rerollCall?.id === last.id && st.rerollCall?.outcome === outcome) return; // already noticed

  await patchAnsu(actor, {
    rerollCall: { id: last.id, from: last.outcome ?? null, outcome, total, at: Date.now() },
  });
  await whisperGM(
    actor,
    game.i18n.format("SHARDS.Ansu.RerollCallNotice", {
      name: actor.name,
      from: outcomeLabel(last.outcome),
      to: outcomeLabel(outcome),
    }),
  );
  refreshAnsuPanel();
}

/**
 * Turn a Call outcome into state. Imports are deferred to call time — the
 * communion/seizure/transform modules form a cycle at load otherwise.
 */
export async function recordCallOutcome(actor, outcome, total = null, { force = false } = {}) {
  const st = readAnsu(actor);
  // `force` is the GM pressing "record the reroll": the first roll cleared the
  // pending marker, so the record it corrects stands in for it.
  const pending =
    st.pendingCall ??
    (force && st.lastCall ? { id: st.lastCall.id, dc: st.lastCall.dc ?? null, createdAt: st.lastCall.at } : null);
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending Call at once (a crit would otherwise Climb twice). (C5)
  // The forced re-record is a second, separate pass over the same id. (0.6.6)
  const key = `${actorKey(actor)}:${pending.id}${force ? ":reroll" : ""}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await recordCallOutcomeInner(actor, st, pending, outcome, total, force);
  } finally {
    recording.delete(key);
  }
}

const recording = new Set();

/** The rounds and return penalty a granting outcome stamps (0.8). */
export function callStampFor(level, outcome) {
  return {
    rounds: durationRoundsFor(level, degreeOf(outcome)),
    returnPenalty: outcome === "failure" ? 2 : 0,
  };
}

const grants = (o) => o === "criticalSuccess" || o === "success" || o === "failure";

async function recordCallOutcomeInner(actor, st, pending, outcome, total, force = false) {
  const prevOutcome = force ? (st.rerollCall?.from ?? st.lastCall?.outcome ?? null) : null;
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "call",
      data: { id: pending.id, dc: pending.dc ?? null, outcome, total, ...(force ? { reroll: true } : {}) },
    },
  ];
  const patch = {
    log,
    pendingCall: null,
    lastCall: { id: pending.id, dc: pending.dc ?? null, outcome, at: Date.now() },
  };
  if (force) patch.rerollCall = null;
  await patchAnsu(actor, patch);

  const say = (key, extra = {}) =>
    whisperGM(
      actor,
      game.i18n.format(key, {
        name: actor.name,
        from: outcomeLabel(prevOutcome),
        to: outcomeLabel(outcome),
        ...extra,
      }),
    );

  if (force) {
    // A correction never replays a resolved outcome blindly: callRerollTransition
    // decides what the new degree may still change. No Climb moves either way.
    const step = callRerollTransition({ mode: st.communion?.mode ?? "none", prevOutcome, outcome });
    if (step.blocked) {
      await say("SHARDS.Ansu.RerollNoRestore");
      refreshAnsuPanel();
      return;
    }
    if (step.restamp) {
      // The running countdown is not re-sent (a running clock never is); the
      // stamp and the penalty move, and the GM hears the new length.
      const stamp = callStampFor(st.level, outcome);
      await patchAnsu(actor, { communion: stamp });
      await say("SHARDS.Ansu.CallRerollRestamp", {
        duration: durationLabel(stamp.rounds),
        penalty: stamp.returnPenalty,
      });
      refreshAnsuPanel();
      return;
    }
    if (!step.liftLockout) {
      refreshAnsuPanel();
      return;
    }
    // The recorded critical failure is withdrawn: its lockout and its release card go.
    await patchAnsu(actor, { lockout: null, pendingRelease: null });
    await say("SHARDS.Ansu.CallRerollLifted");
    if (!step.invoke) {
      refreshAnsuPanel();
      return;
    }
  }

  if (grants(outcome)) {
    const { invokeCommunion } = await import("./communion.mjs");
    const stamp = callStampFor(st.level, outcome);
    const note = game.i18n.localize(
      outcome === "criticalSuccess"
        ? "SHARDS.Ansu.CallCrit"
        : outcome === "success"
          ? "SHARDS.Ansu.CallSuccess"
          : "SHARDS.Ansu.CallFail",
    );
    await invokeCommunion(actor, note, stamp);
    const report =
      outcome === "criticalSuccess"
        ? "SHARDS.Ansu.CallCritReport"
        : outcome === "failure"
          ? "SHARDS.Ansu.CallFailReport"
          : null;
    if (report) {
      await whisperGM(actor, game.i18n.format(report, { name: actor.name, duration: durationLabel(stamp.rounds) }));
    }
  } else if (outcome === "criticalFailure") {
    // No Communion and no seizure (0.8): a 1-minute lockout, and the release
    // card goes up at once at the plain DC (no return penalty).
    const now = game.time?.worldTime ?? 0;
    await patchAnsu(actor, {
      lockout: makeLockout(CALL_CF_LOCKOUT, now),
      communion: { returnPenalty: 0 },
    });
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallCritFailReport", { name: actor.name }));
    // A body the Ansu already holds (a GM seizure) is the GM's to return; a
    // release card there would end a hold nobody released.
    const latest = readAnsu(actor);
    if (latest.communion?.mode !== "seized") {
      const { callRelease, suggestedDC } = await import("./release.mjs");
      await callRelease(actor, suggestedDC(latest), game.i18n.localize("SHARDS.Ansu.CallCritFailReason"));
    }
    // Nothing above reaches a sync. Out of combat no round ever ticks, so pf2e
    // never refills the 1/round door it decremented on Use and the Invoke action
    // read 0 of 1 forever. Inside a fight the round will tick. (0.6.6)
    const { inActiveCombat, syncActor } = await import("../sync.mjs");
    if (!inActiveCombat(actor)) await syncActor(actor);
  }
  refreshAnsuPanel();
}

/** GM-only card. Escaped here, at the choke point: no lang value carries markup. */
async function whisperGM(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${esc(text)}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Discard a pending Call without recording an outcome. */
export async function clearPendingCall(actor) {
  await patchAnsu(actor, { pendingCall: null });
  refreshAnsuPanel();
}

/** Dismiss a captured reroll notice without applying it (the GM's call). */
export async function dismissCallReroll(actor) {
  await patchAnsu(actor, { rerollCall: null });
  refreshAnsuPanel();
}
