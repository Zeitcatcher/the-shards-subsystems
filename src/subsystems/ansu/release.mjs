/**
 * The Release save — the wrestle to hand the borrowed strength back.
 *
 * GM (or the player's Release action) triggers a check → for a PC, a whispered
 * chat card with an inline pf2e @Check the player clicks; for an NPC the GM rolls
 * directly. One createChatMessage capture records the degree of success:
 * clean release feeds the Climb (+1 / +2 crit), failure means Lingering, and a
 * critical failure hands the body to the GM for one round (the hard rule).
 */

import { MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readAnsu, patchAnsu, isAttuned } from "./state.mjs";
import { releaseDC, climbDeltaFor, climbNeeded } from "./logic/model.mjs";
import { readDials } from "./sync.mjs";
import { refreshAnsuPanel } from "./apps/ansu-panel.mjs";

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
 * they end Communion at will.
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
  const check = `@Check[will|dc:${dc}|traits:mental|name:${name}|showDC:${showDc}|options:shards-ansu-release,shards-ansu-release-id:${id}]`;
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
    extraRollOptions: ["shards-ansu-release", `shards-ansu-release-id:${id}`],
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
  if (!pending) return;

  // Match only on the injected roll-option id: present on both the player's card
  // click and the GM's NPC roll. Off-card rolls use the panel's manual recorder,
  // so there is no fuzzy DC/time fallback that could capture an unrelated save
  // (e.g. a Fortitude save vs a poison) at the same DC. (B2)
  const options = ctx.options ?? [];
  if (!options.includes("shards-ansu-release")) return;
  const idOpt = options.find((o) => o.startsWith("shards-ansu-release-id:"));
  if (idOpt?.slice("shards-ansu-release-id:".length) !== pending.id) return;

  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  await recordReleaseOutcome(actor, outcome, total);
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

export async function recordReleaseOutcome(actor, outcome, total = null) {
  const st = readAnsu(actor);
  const pending = st.pendingRelease;
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending Release at once (a crit would otherwise Climb twice). (C5)
  const key = `${actor.id}:${pending.id}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await recordReleaseOutcomeInner(actor, st, pending, outcome, total);
  } finally {
    recording.delete(key);
  }
}

async function recordReleaseOutcomeInner(actor, st, pending, outcome, total) {
  const delta = climbDeltaFor(outcome);
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "release",
      data: { id: pending.id, dc: pending.dc ?? null, outcome, total, climbDelta: delta },
      note: pending.reason ?? "",
    },
  ];
  await patchAnsu(actor, { log, pendingRelease: null });

  const { endCommunion, slipToLingering } = await import("./communion.mjs");

  if (outcome === "success" || outcome === "criticalSuccess") {
    await endCommunion(actor, { via: "release" });
    const { applyClimbChange } = await import("./transform.mjs");
    const r = await applyClimbChange(actor, { delta, source: "release" });
    if (r) await whisperClimbReport(actor, delta, r);
  } else if (outcome === "criticalFailure") {
    const { startSeizure } = await import("./seizure.mjs");
    await startSeizure(actor, { auto: true });
  } else if (outcome === "failure") {
    await slipToLingering(actor);
  }
  refreshAnsuPanel();
}

/** GM-only confirmation of the climb movement after a captured outcome. */
async function whisperClimbReport(actor, delta, r) {
  if (delta <= 0) return;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const d = readDials();
  const needed = climbNeeded(r.level, d.climbBase, d.climbStep);
  let text = game.i18n.format("SHARDS.Ansu.ClimbMoved", { delta, value: r.climb, needed });
  if (r.leveled) text += ` ${game.i18n.format("SHARDS.Ansu.ClimbLeveled", { name: actor.name, level: r.level })}`;
  if (r.atTenth) text += ` ${game.i18n.format("SHARDS.Ansu.TenthReady", { name: actor.name })}`;
  await ChatMessage.create({
    content: `<div class="ansu-card"><p>${text}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Discard a pending release without recording an outcome. */
export async function clearPendingRelease(actor) {
  await patchAnsu(actor, { pendingRelease: null });
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
