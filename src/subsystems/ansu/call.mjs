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

import { MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "./state.mjs";
import { callDC } from "./logic/model.mjs";
import { refreshAnsuPanel } from "./apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

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
  const check = `@Check[intimidation|dc:${dc}|name:${name}|showDC:${showDc}|options:shards-ansu-call,shards-ansu-call-id:${id}]`;
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
    extraRollOptions: ["shards-ansu-call", `shards-ansu-call-id:${id}`],
    rollMode: "gmroll",
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
  if (!pending) return;

  // Match only on the injected roll-option id: present on both the player's card
  // click and the GM's NPC roll. Off-card rolls use the panel's manual recorder,
  // so there is no fuzzy DC/time fallback that could capture an unrelated skill
  // check (e.g. an Athletics check) at the same DC. (B2)
  const options = ctx.options ?? [];
  if (!options.includes("shards-ansu-call")) return;
  const idOpt = options.find((o) => o.startsWith("shards-ansu-call-id:"));
  if (idOpt?.slice("shards-ansu-call-id:".length) !== pending.id) return;

  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  await recordCallOutcome(actor, outcome, total);
}

/**
 * Turn a Call outcome into state. Imports are deferred to call time — the
 * communion/seizure/transform modules form a cycle at load otherwise.
 */
export async function recordCallOutcome(actor, outcome, total = null) {
  const st = readAnsu(actor);
  const pending = st.pendingCall;
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending Call at once (a crit would otherwise Climb twice). (C5)
  const key = `${actor.id}:${pending.id}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await recordCallOutcomeInner(actor, st, pending, outcome, total);
  } finally {
    recording.delete(key);
  }
}

const recording = new Set();

async function recordCallOutcomeInner(actor, st, pending, outcome, total) {
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "call",
      data: { id: pending.id, dc: pending.dc ?? null, outcome, total },
    },
  ];
  await patchAnsu(actor, { log, pendingCall: null });

  const { invokeCommunion } = await import("./communion.mjs");

  if (outcome === "criticalSuccess") {
    await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.CallCrit"));
    const { applyClimbChange } = await import("./transform.mjs");
    await applyClimbChange(actor, { delta: 1, source: "call" });
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallCritReport", { name: actor.name }));
  } else if (outcome === "success") {
    await invokeCommunion(actor, game.i18n.localize("SHARDS.Ansu.CallSuccess"));
  } else if (outcome === "criticalFailure") {
    // The Ansu comes anyway — 1-round Seizure, then Communion under the player.
    const { startSeizure } = await import("./seizure.mjs");
    await startSeizure(actor, { auto: true, thenMode: "active" });
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallCritFailReport", { name: actor.name }));
  } else if (outcome === "failure") {
    await whisperGM(actor, game.i18n.format("SHARDS.Ansu.CallFailReport", { name: actor.name }));
  }
  refreshAnsuPanel();
}

async function whisperGM(actor, text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${text}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Discard a pending Call without recording an outcome. */
export async function clearPendingCall(actor) {
  await patchAnsu(actor, { pendingCall: null });
  refreshAnsuPanel();
}
