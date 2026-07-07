/**
 * Izir's Terror, save-first. The aura still marks enemies that enter (a rule-free
 * tracker effect), but nothing lands automatically: when the marker appears, the GM
 * gets a chat prompt with a Will save against the bearer's temptation DC. Only a
 * failed roll applies frightened (1 on a failure, 2 on a critical failure, matching
 * official Frightful Presence outcomes).
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { isPrimaryGM } from "../../core/platform.mjs";
import { readIzir, isMarked } from "./state.mjs";
import { suggestedDC } from "./temptation.mjs";

const MARKER_SLUG = "shards-izir-pack-izirterroraura00";
const ROLL_OPTION = "shards-izir-terror";

/** Resolve the aura's origin (the Nameless bearer) from the marker effect. */
function bearerOf(markerItem) {
  const originUuid = markerItem.flags?.pf2e?.aura?.origin;
  if (!originUuid) return null;
  const doc = fromUuidSync(originUuid);
  if (!doc) return null;
  return doc.documentName === "Actor" ? doc : (doc.actor ?? null);
}

async function promptTerrorSave(markerItem) {
  const target = markerItem.parent;
  if (!target) return;
  const bearer = bearerOf(markerItem);
  if (!bearer || !isMarked(bearer)) return;

  const dc = suggestedDC(readIzir(bearer));
  const check = `@Check[will|dc:${dc}|traits:emotion,fear,mental|name:Izir's Terror|showDC:gm|options:${ROLL_OPTION}]`;
  const owners = (game.users?.contents ?? [])
    .filter((u) => !u.isGM && target.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);

  await ChatMessage.create({
    content: `<div class="izir-temptation-card">
      <p class="izir-card-title"><i class="fa-solid fa-skull"></i> ${game.i18n.localize("SHARDS.Izir.TerrorTitle")}</p>
      <p>${game.i18n.format("SHARDS.Izir.TerrorPrompt", {
        target: foundry.utils.escapeHTML(target.name),
        bearer: foundry.utils.escapeHTML(bearer.name),
      })}</p>
      <p>${check}</p>
    </div>`,
    whisper: [...new Set([...owners, ...gmIds])],
    speaker: ChatMessage.getSpeaker({ actor: target }),
  });
}

/** Raise frightened to at least `value` (bounded; frightened caps at 4). */
async function applyFrightened(actor, value) {
  for (let i = 0; i < 4; i += 1) {
    const current = actor.getCondition?.("frightened")?.value ?? 0;
    if (current >= value) break;
    await actor.increaseCondition("frightened");
  }
}

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  if (!ctx.options?.includes(ROLL_OPTION)) return;

  const doc = ctx.actor ? fromUuidSync(ctx.actor) : null;
  const actor = doc?.documentName === "Actor" ? doc : (doc?.actor ?? game.actors.get(message.speaker?.actor));
  if (!actor) return;

  if (ctx.outcome === "failure") await applyFrightened(actor, 1);
  else if (ctx.outcome === "criticalFailure") await applyFrightened(actor, 2);
}

/** Register the marker watcher and the save capture. Primary GM only. Call on ready. */
export function registerTerrorHooks() {
  Hooks.on("createItem", (item) => {
    if (!isPrimaryGM()) return;
    if (item.type !== "effect" || item.system?.slug !== MARKER_SLUG) return;
    promptTerrorSave(item).catch((err) => console.error(`${MODULE_ID} | terror prompt`, err));
  });

  Hooks.on("createChatMessage", (message) => {
    if (!isPrimaryGM()) return;
    captureFromMessage(message).catch((err) => console.error(`${MODULE_ID} | terror capture`, err));
  });
}
