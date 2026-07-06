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
import { dcFor } from "./logic/model.mjs";
import { refreshIzirPanel } from "./apps/izir-panel.mjs";

const dcBase = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_BASE)) || 14;
const dcStep = () => Number(game.settings.get(MODULE_ID, SETTINGS.IZIR_DC_STEP)) || 0;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Non-GM users who own this actor (players who can roll for it). */
function playerOwners(actor) {
  return (game.users?.contents ?? [])
    .filter((u) => !u.isGM && actor.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
}

/** Open the temptation dialog, write the pending marker, then whisper or roll. */
export async function openTemptationDialog(actor) {
  if (!actor) return;
  const st = readIzir(actor);
  const suggested = dcFor(st.level, dcBase(), dcStep());

  const content = `
    <div class="form-group">
      <label>${game.i18n.localize("SHARDS.Izir.TemptationDC")}</label>
      <input type="number" name="dc" value="${suggested}" step="1" min="1" autofocus>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("SHARDS.Izir.TemptationReason")}</label>
      <input type="text" name="reason" value="" placeholder="${game.i18n.localize("SHARDS.Izir.TemptationReasonHint")}">
    </div>`;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SHARDS.Izir.TemptationTitle"), icon: "fa-solid fa-hand-sparkles" },
    content,
    ok: {
      label: game.i18n.localize("SHARDS.Izir.TemptationRoll"),
      icon: "fa-solid fa-dice-d20",
      callback: (_ev, button) => ({
        dc: Number(button.form.elements.dc.value),
        reason: String(button.form.elements.reason.value ?? "").trim(),
      }),
    },
  }).catch(() => null);
  if (!result || !Number.isFinite(result.dc)) return;

  const id = foundry.utils.randomID();
  await patchIzir(actor, { pendingTemptation: { id, dc: result.dc, reason: result.reason, createdAt: Date.now() } });

  const owners = playerOwners(actor);
  if (owners.length) await postTemptationCard(actor, id, result.dc, result.reason, owners);
  else await rollNpcTemptation(actor, id, result.dc);
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
export function registerTemptationHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | temptation capture`, err));
  });
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  const actor = resolveActor(message, ctx);
  if (!actor || !isMarked(actor)) return;

  const st = readIzir(actor);
  const pending = st.pendingTemptation;
  if (!pending) return;

  const options = ctx.options ?? [];
  let matches = false;
  if (options.includes("shards-izir-temptation")) {
    // Primary channel: the injected roll option carries the pending id.
    const idOpt = options.find((o) => o.startsWith("shards-izir-temptation-id:"));
    matches = idOpt?.slice("shards-izir-temptation-id:".length) === pending.id;
  } else {
    // Fallback: same actor, same DC, within 30 minutes.
    const within = Date.now() - (pending.createdAt ?? 0) < 30 * 60 * 1000;
    matches = ctx.dc?.value === pending.dc && within;
  }
  if (!matches) return;

  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;
  await recordTemptationOutcome(actor, outcome, total);
}

/** Write a temptation outcome to the log and clear the pending marker. */
export async function recordTemptationOutcome(actor, outcome, total = null) {
  const st = readIzir(actor);
  const pending = st.pendingTemptation;
  const log = [
    ...st.log,
    {
      t: Date.now(),
      type: "temptation",
      data: { id: pending?.id ?? null, dc: pending?.dc ?? null, outcome, total },
      note: pending?.reason ?? "",
    },
  ];
  await patchIzir(actor, { log, pendingTemptation: null });
  refreshIzirPanel();
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
