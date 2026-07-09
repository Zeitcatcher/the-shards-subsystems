/**
 * Искушение Изира — the temptation subsystem.
 *
 * GM triggers a check from the panel → for a PC, a whispered chat card with an inline
 * pf2e @Check the player clicks; for an NPC, the GM rolls directly. Either way the
 * result flows through one createChatMessage capture that logs the degree of success
 * and clears the pending marker. Nothing auto-applies — the GM acts on suggestions.
 */

import { MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readIzir, patchIzir, isMarked } from "./state.mjs";
import { dcFor, slideDeltaFor, slideNeeded } from "./logic/model.mjs";
import { applySlideChange } from "./transform.mjs";
import { refreshIzirPanel } from "./apps/izir-panel.mjs";

const dcBase = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_BASE)) || 20;
const dcStep = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_STEP)) || 0;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** The default temptation DC for an actor's current immersion. */
export function suggestedDC(state) {
  return dcFor(state.level, dcBase(), dcStep());
}

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/**
 * Start a temptation check with a known DC and reason (the panel supplies both
 * inline). Writes the pending marker, then whispers the card (PC) or rolls (NPC).
 */
export async function callTemptation(actor, dc, reason = "") {
  if (!actor || !Number.isFinite(dc)) return;
  const id = foundry.utils.randomID();
  await patchIzir(actor, { pendingTemptation: { id, dc, reason, createdAt: Date.now() } });

  const owners = playerOwners(actor);
  if (owners.length) await postTemptationCard(actor, id, dc, reason, owners);
  else await rollNpcTemptation(actor, id, dc);
  refreshIzirPanel();
}

/** PC path: a whispered card with an inline check the player clicks. */
async function postTemptationCard(actor, id, dc, reason, ownerIds) {
  const showDc = game.settings.get(MODULE_ID, SETTINGS.IZIR_SHOW_DC) || "gm";
  const name = game.i18n.localize("SHARDS.Izir.TemptationTitle");
  const check = `@Check[will|dc:${dc}|traits:mental,izir|name:${name}|showDC:${showDc}|options:shards-izir-temptation,shards-izir-temptation-id:${id}]`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...ownerIds, ...gmIds])];
  const body = reason ? `<p class="izir-card-reason"><em>${esc(reason)}</em></p>` : "";
  const content = `<div class="izir-temptation-card">
    <p class="izir-card-title"><i class="fa-solid fa-eye"></i> ${game.i18n.localize("SHARDS.Izir.TemptationCardTitle")}</p>
    ${body}
    <p>${check}</p>
  </div>`;
  await ChatMessage.create({ content, whisper, speaker: ChatMessage.getSpeaker({ actor }) });
}

/** NPC path: GM rolls the save directly; same tag → same capture. */
async function rollNpcTemptation(actor, id, dc) {
  const will = actor.getStatistic?.("will") ?? actor.saves?.will;
  if (!will?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.NoWill"));
    return;
  }
  await will.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Izir.TemptationTitle"),
    extraRollOptions: ["shards-izir-temptation", `shards-izir-temptation-id:${id}`],
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
export function registerTemptationHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | temptation capture`, err));
  });
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  const actor = resolveActor(message);
  if (!actor || !isMarked(actor)) return;

  const st = readIzir(actor);
  const pending = st.pendingTemptation;
  if (!pending) return;

  // Match only on the injected roll-option id: an unambiguous channel present on
  // both the player's card click and the GM's NPC roll. Off-card rolls go through
  // the panel's manual recorder, so there is no fuzzy DC/time fallback that could
  // capture an unrelated saving throw at the same DC. (B2)
  const options = ctx.options ?? [];
  if (!options.includes("shards-izir-temptation")) return;
  const idOpt = options.find((o) => o.startsWith("shards-izir-temptation-id:"));
  if (idOpt?.slice("shards-izir-temptation-id:".length) !== pending.id) return;

  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  await recordTemptationOutcome(actor, outcome, total);
}

/**
 * Write a temptation outcome to the log, clear the pending marker, and move the
 * slide (fail +1, crit fail +2 — successes hold). The slide may auto-raise the
 * level or signal the Tenth Step; a small GM whisper reports what moved.
 */
const recording = new Set();

export async function recordTemptationOutcome(actor, outcome, total = null) {
  const st = readIzir(actor);
  const pending = st.pendingTemptation;
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending at once. The check-and-add is synchronous (before any await), so
  // only the first caller proceeds; the slide can't move twice for one save. (C5)
  const key = `${actor.id}:${pending.id}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    const delta = slideDeltaFor(outcome);
    const log = [
      ...st.log,
      {
        t: Date.now(),
        type: "temptation",
        data: { id: pending.id, dc: pending.dc ?? null, outcome, total, slideDelta: delta },
        note: pending.reason ?? "",
      },
    ];
    await patchIzir(actor, { log, pendingTemptation: null });

    if (delta > 0) {
      const r = await applySlideChange(actor, { delta, source: "temptation" });
      if (r) await whisperSlideReport(actor, delta, r);
    }
    refreshIzirPanel();
  } finally {
    recording.delete(key);
  }
}

/** GM-only confirmation of the slide movement after a captured outcome. */
async function whisperSlideReport(actor, delta, r) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const needed = slideNeeded(r.level);
  let text = game.i18n.format("SHARDS.Izir.SlideMoved", { delta, value: r.slide, needed });
  if (r.leveled) text += ` ${game.i18n.format("SHARDS.Izir.SlideLeveled", { name: actor.name, level: r.level })}`;
  if (r.atTenth) text += ` ${game.i18n.format("SHARDS.Izir.TenthReady", { name: actor.name })}`;
  await ChatMessage.create({
    content: `<div class="izir-temptation-card"><p>${text}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Discard a pending temptation without recording an outcome. */
export async function clearPendingTemptation(actor) {
  await patchIzir(actor, { pendingTemptation: null });
  refreshIzirPanel();
}

/** Chip action: a short "the void surges" whisper to the player + GM. */
export async function postSurge(actor) {
  const owners = playerOwners(actor);
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...owners, ...gmIds])];
  await ChatMessage.create({
    content: `<div class="izir-temptation-card"><p class="izir-card-title"><i class="fa-solid fa-skull"></i> ${game.i18n.localize("SHARDS.Izir.SurgeTitle")}</p><p><em>${game.i18n.localize("SHARDS.Izir.SurgeText")}</em></p></div>`,
    whisper,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Chip action: a quiet reminder of the price to the player. */
export async function postReminder(actor) {
  const owners = playerOwners(actor);
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...owners, ...gmIds])];
  await ChatMessage.create({
    content: `<div class="izir-temptation-card"><p><em>${game.i18n.localize("SHARDS.Izir.RemindText")}</em></p></div>`,
    whisper,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}
