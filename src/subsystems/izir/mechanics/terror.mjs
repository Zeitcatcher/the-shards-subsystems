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
import { encounterOf } from "./recharge.mjs";

const MARKER_SLUG = "shards-izir-pack-izirterroraura00";
const ROLL_OPTION = "shards-izir-terror";
const ID_PREFIX = "shards-izir-terror-id:";
const IMMUNITY_SLUG = "shards-izir-terror-immune";
const IMMUNITY_MINUTES = 1;
const COMBAT_FLAG = "terrorImmuneCombat";

/**
 * What each prompted save actually applied, keyed by `<target>:<save id>`. pf2e's
 * reroll re-posts the same context, so the second result has to REPLACE the first
 * rather than only raise frightened further — a critical failure rerolled into a
 * success must take the condition back off. Held in memory on the GM client that
 * prompted: a reload between the roll and its reroll loses the record, and the
 * reroll then behaves as it did before (raise-only). (F2)
 */
const applied = new Map();
const APPLIED_CAP = 200;

/** Remember what a save applied, oldest-out so a long session can't grow the map. */
function rememberApplied(key, value) {
  applied.set(key, value);
  while (applied.size > APPLIED_CAP) applied.delete(applied.keys().next().value);
}

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
  const saveId = foundry.utils.randomID();
  const check = `@Check[will|dc:${dc}|traits:emotion,fear,mental|name:Izir's Terror|showDC:gm|options:${ROLL_OPTION},${ID_PREFIX}${saveId}]`;
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

/**
 * Does this target already carry a live Terror immunity from this bearer?
 *
 * Frightful Presence is once per encounter, and a wall-clock minute is not that:
 * a long fight let the same foe be prompted again and again, while a marker left
 * over from an earlier fight silently suppressed the first save of the next one.
 * Copies stamped with a different encounter are stale — deleted here rather than
 * left to a pf2e automation setting the world may have switched off. (F14)
 */
function hasTerrorImmunity(target, bearer) {
  const combatId = encounterOf(target)?.id ?? null;
  const mine = (target.items ?? []).filter(
    (i) =>
      i.type === "effect" &&
      i.system?.slug === IMMUNITY_SLUG &&
      i.getFlag?.(MODULE_ID, "terrorImmuneFrom") === bearer.uuid,
  );

  const stale = [];
  let immune = false;
  for (const i of mine) {
    const stamped = i.getFlag?.(MODULE_ID, COMBAT_FLAG) ?? null;
    const expired = i.isExpired === true || i.system?.expired === true;
    if (expired || stamped !== combatId) stale.push(i.id);
    else immune = true;
  }
  if (stale.length) {
    target.deleteEmbeddedDocuments("Item", stale).catch(() => {});
  }
  return immune;
}

/**
 * Grant the per-bearer immunity. Inside an encounter it is stamped with that
 * encounter and rides pf2e's "encounter" duration; outside one there is no
 * encounter to be once-per, so it falls back to the wall-clock minute.
 */
async function grantTerrorImmunity(target, bearer) {
  const combat = encounterOf(target);
  const duration = combat
    ? { value: -1, unit: "encounter", sustained: false, expiry: null }
    : { value: IMMUNITY_MINUTES, unit: "minutes", sustained: false, expiry: "turn-start" };
  try {
    await target.createEmbeddedDocuments("Item", [
      {
        name: game.i18n.localize("SHARDS.Izir.TerrorImmuneName"),
        type: "effect",
        img: "icons/magic/unholy/orb-glowing-purple.webp",
        system: {
          slug: IMMUNITY_SLUG,
          description: { value: `<p>${game.i18n.localize("SHARDS.Izir.TerrorImmuneDesc")}</p>` },
          duration,
          unidentified: false,
          level: { value: 1 },
          tokenIcon: { show: false },
          traits: { value: [], rarity: "common" },
          rules: [],
          start: { value: 0, initiative: null },
          publication: { title: "The Shards", authors: "Zeitcatcher", license: "ORC", remaster: true },
        },
        flags: { [MODULE_ID]: { terrorImmuneFrom: bearer.uuid, [COMBAT_FLAG]: combat?.id ?? null } },
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

/** Take back `steps` of frightened this aura had applied, leaving other sources be. */
async function reduceFrightened(actor, steps) {
  for (let i = 0; i < steps; i += 1) {
    if ((actor.getCondition?.("frightened")?.value ?? 0) <= 0) break;
    await actor.decreaseCondition("frightened");
  }
}

/** Frightened value an outcome calls for (official Frightful Presence degrees). */
const frightenedFor = (outcome) =>
  outcome === "criticalFailure" ? 2 : outcome === "failure" ? 1 : 0;

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  const options = ctx.options ?? [];
  if (!options.includes(ROLL_OPTION)) return;

  // Token-aware resolution: the aura's victims are usually unlinked enemy tokens,
  // which flags.pf2e.context.actor (a bare world-actor id) cannot resolve. (B1)
  const actor = resolveActor(message);
  if (!actor) return;

  const want = frightenedFor(ctx.outcome);
  const saveId = options.find((o) => o.startsWith(ID_PREFIX))?.slice(ID_PREFIX.length);
  const key = saveId ? `${actor.uuid}:${saveId}` : null;
  const isReroll = ctx.isReroll === true || options.includes("check:reroll");

  if (isReroll && key && applied.has(key)) {
    // Second result for a save we already resolved: move frightened by the
    // difference, in either direction, instead of stacking another increase.
    const had = applied.get(key);
    if (want > had) await applyFrightened(actor, want);
    else if (want < had) await reduceFrightened(actor, had - want);
    rememberApplied(key, want);
    return;
  }

  if (want > 0) await applyFrightened(actor, want);
  if (key) rememberApplied(key, want);
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
