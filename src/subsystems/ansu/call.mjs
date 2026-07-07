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
  const base = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_BASE)) || 20;
  const step = Number(game.settings.get(MODULE_ID, SETTINGS.ANSU_CALL_STEP)) ?? 2;
  return callDC(state.level, base, step);
}

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/**
 * Start the Call: write the pending marker, then whisper the card (PC) or roll
 * (NPC). Guarded by the panel/communion layer — this assumes a dormant, non-
 * terminal bearer with attunement ≥ 1.
 */
export async function callTheCall(actor, dc) {
  if (!actor || !Number.isFinite(dc)) return;
  const st = readAnsu(actor);
  if (st.terminal || st.pendingCall) return;
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

function resolveActor(message, ctx) {
  const uuid = ctx.actor;
  if (uuid) {
    const doc = fromUuidSync(uuid);
    if (doc?.documentName === "Actor") return doc;
    if (doc?.actor) return doc.actor;
  }
  const sid = message.speaker?.actor;
  return sid ? game.actors.get(sid) : null;
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
  const actor = resolveActor(message, ctx);
  if (!actor || !isAttuned(actor)) return;

  const st = readAnsu(actor);
  const pending = st.pendingCall;
  if (!pending) return;

  const options = ctx.options ?? [];
  let matches = false;
  if (options.includes("shards-ansu-call")) {
    // Primary channel: the injected roll option carries the pending id.
    const idOpt = options.find((o) => o.startsWith("shards-ansu-call-id:"));
    matches = idOpt?.slice("shards-ansu-call-id:".length) === pending.id;
  } else {
    // Fallback: an Intimidation check against the same DC within 30 minutes.
    const within = Date.now() - (pending.createdAt ?? 0) < 30 * 60 * 1000;
    matches = ctx.dc?.value === pending.dc && within;
  }
  if (!matches) return;

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
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "call",
      data: { id: pending?.id ?? null, dc: pending?.dc ?? null, outcome, total },
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
