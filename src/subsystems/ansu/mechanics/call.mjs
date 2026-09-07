/**
 * The Call — the Intimidation gate on Invoking the Ansu (attunement 1–9).
 *
 * The power is never owed: to summon it the bearer must show strength. Invoke
 * posts a whispered chat card with an inline pf2e @Check (Intimidation vs the
 * Call DC — 20 + 2 × attunement, uncapped); one createChatMessage capture turns
 * the degree of success into state:
 *   crit success — the Ansu answers eagerly: Communion + 1 to the Climb
 *   success      — Communion begins
 *   failure      — the Ansu does not deign; the action is spent, retry allowed
 *   crit failure — the Ansu comes ANYWAY: 1-round Seizure, then Communion
 * Subjugated masters skip the Call entirely (free toggle); the GM's force-invoke
 * bypasses it when the story says so.
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "../state.mjs";
import { callDC } from "../logic/model.mjs";
import {
  acceptCallRoll,
  acceptRerollCapture,
  rerollTransition,
  CALL_OPTION,
  CALL_ID_PREFIX,
} from "../logic/timing.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** A degree of success in words, or a dash when there isn't one. */
const outcomeLabel = (o) => (o ? game.i18n.localize(`SHARDS.Ansu.Outcome.${o}`) : "—");

/** The default Call DC for an actor's current attunement (settings dials). */
export function suggestedCallDC(state) {
  const base = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_BASE));
  const step = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_STEP));
  return callDC(state.level, Number.isFinite(base) ? base : 20, Number.isFinite(step) ? step : 2);
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

/** PC path: a whispered card with an inline Intimidation check the player clicks. */
async function postCallCard(actor, id, dc, ownerIds) {
  const showDc = game.settings.get(MODULE_ID, SETTINGS.ANSU_SHOW_DC) || "gm";
  const name = game.i18n.localize("SHARDS.Ansu.CallTitle");
  // roller:self — without it pf2e rolls for whatever token the clicker has
  // selected and only falls back to the card's actor when nothing is (an enemy
  // selected, and the GM rolls the enemy's Intimidation). The card is whispered
  // to owners plus GMs, all of whom can update the actor, so nobody hits pf2e's
  // plain-text downgrade at text-editor.ts:722. (0.6.6)
  const check = `@Check[intimidation|dc:${dc}|name:${name}|showDC:${showDc}|roller:self|options:${CALL_OPTION},${CALL_ID_PREFIX}${id}]`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...ownerIds, ...gmIds])];
  const content = `<div class="ansu-card">
    <p class="ansu-card-title"><i class="fa-solid fa-hand-fist"></i> ${game.i18n.localize("SHARDS.Ansu.CallCardTitle")}</p>
    <p class="ansu-card-reason"><em>${esc(game.i18n.localize("SHARDS.Ansu.CallFlavor"))}</em></p>
    <p>${check}</p>
  </div>`;
  await ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** NPC path: GM rolls Intimidation directly; same tag → same capture. */
async function rollNpcCall(actor, id, dc) {
  const intimidation = actor.getStatistic?.("intimidation") ?? actor.skills?.intimidation;
  if (!intimidation?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Ansu.NoIntimidation"));
    await patchAnsu(actor, { pendingCall: null });
    return;
  }
  await intimidation.roll({
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
  // check (e.g. an Athletics check) at the same DC. (B2)
  // The card id decides which card was rolled, but a mismatch is no longer
  // thrown away: requestInvoke deliberately REPLACES a stale pending Call, so
  // two live cards are reachable and rolling the older one spent the action for
  // nothing. Same rule the Release got in 0.6.5. (0.6.6)
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
 * critical failure has the body, a recorded success has a Communion the table
 * has been playing under. The GM gets a card and the panel gets a button.
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

/** The Call's own Climb rule: only an eager answer moves the bar. */
const callClimbFor = (outcome) => (outcome === "criticalSuccess" ? 1 : 0);

async function recordCallOutcomeInner(actor, st, pending, outcome, total, force = false) {
  const prevOutcome = force ? (st.rerollCall?.from ?? st.lastCall?.outcome ?? null) : null;
  // A correction owes only the DIFFERENCE in Climb, and never takes one back:
  // the GM has the ± controls and may already have spent the level. (0.6.6)
  const delta = Math.max(0, callClimbFor(outcome) - (force ? callClimbFor(prevOutcome) : 0));
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

  const { invokeCommunion } = await import("./communion.mjs");

  if (force) {
    const step = rerollTransition({ mode: st.communion?.mode ?? "none", prevOutcome, outcome });
    if (step.returnBody) {
      // The recorded critical failure took the body, and the correction says it
      // never happened: restore the pre-seizure snapshot (dormant, for a Call)
      // rather than the seizure's landing state, then apply the new outcome from
      // there. Landing in `thenMode` would hand a FAILED Call a live Communion,
      // which is the one thing a failed Call must never buy. (0.6.6)
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

  // A forced correction may have landed the bearer in Communion already (the
  // returned body), and invokeCommunion warns rather than no-ops when it has.
  const running = force && readAnsu(actor).communion?.mode !== "none";

  if (outcome === "criticalSuccess") {
    if (!running) await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.CallCrit"));
    const { applyClimbChange } = await import("../transform.mjs");
    if (delta > 0) await applyClimbChange(actor, { delta, source: "call" });
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallCritReport", { name: actor.name }));
  } else if (outcome === "success") {
    if (!running) await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.CallSuccess"));
  } else if (outcome === "criticalFailure") {
    // The Ansu comes anyway — 1-round Seizure, then Communion under the player.
    // startSeizure names that landing in its own card, so there is no second one
    // here; and a seizure that never started (the Ansu already has the body from
    // a manual hold) must not be reported as though it did. (0.6.6)
    const { startSeizure } = await import("./seizure.mjs");
    const seized = await startSeizure(actor, { auto: true, thenMode: "active" });
    if (!seized) await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallCritFailHeld", { name: actor.name }));
  } else if (outcome === "failure") {
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallFailReport", { name: actor.name }));
    // This is the only outcome that never reaches a sync: the successes go
    // through invokeCommunion and the critical failure through startSeizure. Out
    // of combat no round ever ticks, so pf2e never refills the 1/round door pf2e
    // itself decremented on Use, and the Invoke action read 0 of 1 forever.
    // Inside a fight the round WILL tick, and refunding the use there would
    // break "the action is spent, and you may try again next round". (0.6.6)
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
