/**
 * Izir's Terror, save-first. The aura still marks enemies that enter (a rule-free
 * tracker effect), but nothing lands automatically: when the marker appears, the GM
 * gets a chat prompt with a Will save against the bearer's temptation DC. Only a
 * failed roll applies frightened (1 on a failure, 2 on a critical failure, matching
 * official Frightful Presence outcomes).
 */

import { MODULE_ID } from "../../../core/constants.mjs";
import { isPrimaryGM } from "../../../core/platform.mjs";
import { readIzir, isMarked } from "../state.mjs";
import { suggestedDC } from "./temptation.mjs";

const MARKER_SLUG = "shards-izir-pack-izirterroraura00";
const ROLL_OPTION = "shards-izir-terror";
const IMMUNITY_SLUG = "shards-izir-terror-immune";
const IMMUNITY_MINUTES = 1;

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

  // Frightful Presence shape: only the FIRST entry each minute prompts a save; a
  // foe that steps out and back in is immune, so the aura can't be farmed by
  // yo-yoing across its edge. (D2)
  if (hasTerrorImmunity(target, bearer)) return;

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

  await grantTerrorImmunity(target, bearer);
}

/** Does this target already carry a live Terror immunity from this bearer? */
function hasTerrorImmunity(target, bearer) {
  return (target.items ?? []).some(
    (i) =>
      i.type === "effect" &&
      i.system?.slug === IMMUNITY_SLUG &&
      i.getFlag?.(MODULE_ID, "terrorImmuneFrom") === bearer.uuid &&
      !(i.isExpired === true || i.system?.expired === true),
  );
}

/** Apply a 1-minute per-bearer immunity so re-entry doesn't re-prompt. */
async function grantTerrorImmunity(target, bearer) {
  try {
    await target.createEmbeddedDocuments("Item", [
      {
        name: game.i18n.localize("SHARDS.Izir.TerrorImmuneName"),
        type: "effect",
        img: "icons/magic/unholy/orb-glowing-purple.webp",
        system: {
          slug: IMMUNITY_SLUG,
          description: { value: `<p>${game.i18n.localize("SHARDS.Izir.TerrorImmuneDesc")}</p>` },
          duration: { value: IMMUNITY_MINUTES, unit: "minutes", sustained: false, expiry: "turn-start" },
          unidentified: false,
          level: { value: 1 },
          tokenIcon: { show: false },
          traits: { value: [], rarity: "common" },
          rules: [],
          start: { value: 0, initiative: null },
          publication: { title: "The Shards", authors: "Zeitcatcher", license: "ORC", remaster: true },
        },
        flags: { [MODULE_ID]: { terrorImmuneFrom: bearer.uuid } },
      },
    ]);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not apply terror immunity`, err);
  }
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

  // Token-aware resolution: the aura's victims are usually unlinked enemy tokens,
  // which flags.pf2e.context.actor (a bare world-actor id) cannot resolve. (B1)
  const actor = resolveActor(message);
  if (!actor) return;

  if (ctx.outcome === "failure") await applyFrightened(actor, 1);
  else if (ctx.outcome === "criticalFailure") await applyFrightened(actor, 2);
}

/** Resolve the saving actor, scene/token aware (works for unlinked tokens). */
function resolveActor(message) {
  if (message.actor) return message.actor;
  const { scene, token, actor } = message.speaker ?? {};
  if (scene && token) {
    const t = game.scenes?.get(scene)?.tokens?.get(token);
    if (t?.actor) return t.actor;
  }
  return actor ? game.actors.get(actor) : null;
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
