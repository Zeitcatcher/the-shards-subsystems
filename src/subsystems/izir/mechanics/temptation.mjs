/**
 * Искушение Изира — the temptation subsystem.
 *
 * GM triggers a check from the panel → for a PC, a whispered chat card with an inline
 * pf2e @Check the player clicks; for an NPC, the GM rolls directly. Either way the
 * result flows through one createChatMessage capture that logs the degree of success
 * and clears the pending marker. Nothing auto-applies — the GM acts on suggestions.
 */

import { MODULE_ID, SETTINGS } from "../../../core/constants.mjs";
import { isPrimaryGM, actorKey } from "../../../core/platform.mjs";
import { readIzir, patchIzir, appendLog, isMarked, withActorLock } from "../state.mjs";
import { dcFor, slideDeltaFor, slideNeeded, rerollCorrection } from "../logic/model.mjs";
import { applySlideChangeInner, rewindLevelSlide } from "../transform.mjs";
import { refreshIzirPanel } from "../apps/izir-panel.mjs";

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

  // The marker is written first because the NPC capture fires from inside
  // will.roll and needs to find it. If the dispatch then fails — no Will
  // statistic, a dismissed check dialog, a rejected chat write — the marker has to
  // go, or the panel sits on a pending roll that will never arrive. (F20)
  const owners = playerOwners(actor);
  const sent = owners.length
    ? await postTemptationCard(actor, id, dc, reason, owners)
    : await rollNpcTemptation(actor, id, dc);
  if (!sent) await patchIzir(actor, { pendingTemptation: null });
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
  try {
    await ChatMessage.create(
      { content, whisper, speaker: ChatMessage.getSpeaker({ actor }) },
      { chatBubble: false },
    );
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | temptation card`, err);
    return false;
  }
}

/** NPC path: GM rolls the save directly; same tag → same capture. */
async function rollNpcTemptation(actor, id, dc) {
  const will = actor.getStatistic?.("will") ?? actor.saves?.will;
  if (!will?.roll) {
    ui.notifications?.warn(game.i18n.localize("SHARDS.Izir.NoWill"));
    return false;
  }
  const roll = await will.roll({
    dc: { value: dc },
    label: game.i18n.localize("SHARDS.Izir.TemptationTitle"),
    extraRollOptions: ["shards-izir-temptation", `shards-izir-temptation-id:${id}`],
    // pf2e's Statistic#roll reads `messageMode`, never `rollMode` — the old key
    // was inert, so the GM's NPC temptation roll went out in the open. (F3)
    messageMode: "gm",
  });
  // A dismissed check dialog resolves null: nothing was rolled.
  return Boolean(roll);
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

const ID_PREFIX = "shards-izir-temptation-id:";

async function captureFromMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ctx || ctx.type !== "saving-throw") return;
  const actor = resolveActor(message);
  if (!actor || !isMarked(actor)) return;

  // Match only on the injected roll-option id: an unambiguous channel present on
  // both the player's card click and the GM's NPC roll. Off-card rolls go through
  // the panel's manual recorder, so there is no fuzzy DC/time fallback that could
  // capture an unrelated saving throw at the same DC. (B2)
  const options = ctx.options ?? [];
  if (!options.includes("shards-izir-temptation")) return;
  const idOpt = options.find((o) => o.startsWith(ID_PREFIX));
  const id = idOpt?.slice(ID_PREFIX.length);
  if (!id) return;

  const outcome = ctx.outcome ?? null;
  const total = message.rolls?.[0]?.total ?? null;

  if (readIzir(actor).pendingTemptation?.id === id) {
    await recordTemptationOutcome(actor, outcome, total);
    return;
  }

  // No pending marker for this id, so the first result is already recorded. pf2e's
  // reroll deletes the original message and posts a replacement carrying the same
  // context — including our id — with `isReroll` set and a `check:reroll` option.
  // Without this branch the second result was simply dropped and the track kept a
  // result the table had already thrown away. (F2)
  if (ctx.isReroll === true || options.includes("check:reroll")) {
    await reconcileReroll(actor, id, outcome, total);
  }
}

/**
 * Write a temptation outcome to the log, clear the pending marker, and move the
 * slide (fail +1, crit fail +2 — successes hold). The slide may auto-raise the
 * level or signal the Tenth Step; a small GM whisper reports what moved.
 */
const recording = new Set();

export async function recordTemptationOutcome(actor, outcome, total = null) {
  const pending = readIzir(actor).pendingTemptation;
  if (!pending) return; // already recorded (auto-capture cleared it) — nothing to do
  // Guard a double-apply when auto-capture and the manual recorder fire for the
  // same pending at once. The check-and-add is synchronous (before any await), so
  // only the first caller proceeds; the slide can't move twice for one save. (C5)
  const key = `${actorKey(actor)}:${pending.id}`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await withActorLock(actor, () => recordInner(actor, pending, outcome, total));
    refreshIzirPanel();
  } finally {
    recording.delete(key);
  }
}

async function recordInner(actor, pending, outcome, total) {
  const st = readIzir(actor);
  if (st.terminal === "nineveh") {
    // The character is gone. A late click on an old card should not write into
    // their log as though the track were still running. (F20)
    await patchIzir(actor, { pendingTemptation: null });
    return;
  }

  const delta = slideDeltaFor(outcome);
  // `prev` is the track as it stood before this save moved it. A reroll rewinds
  // to it rather than trying to subtract the old result back out. (F2)
  const prev = { level: st.level, slide: st.slide ?? 0 };

  // Clear the marker first (the C5 guard keys on it), then move the slide, then
  // log what ACTUALLY happened. Logging the intended delta first was a lie
  // whenever the slide refused it: a level-0 or capped bearer got a "+2" in the
  // history and the exported journal while nothing moved. (F19)
  await patchIzir(actor, { pendingTemptation: null });

  let r = null;
  if (delta > 0) r = await applySlideChangeInner(actor, { delta, source: "temptation", cause: pending.id });
  const moved = Boolean(r) && (r.level !== prev.level || r.slide !== prev.slide);

  await appendLog(
    actor,
    "temptation",
    { id: pending.id, dc: pending.dc ?? null, outcome, total, slideDelta: moved ? delta : 0, applied: moved, prev },
    pending.reason ?? "",
  );

  if (delta > 0) await whisperSlideReport(actor, delta, r, moved, prev);
}

/**
 * Replay a temptation whose save was rerolled: rewind the track to the snapshot
 * taken before the first result, drop the slide and level entries that result
 * caused, rewrite the temptation entry, then apply the new outcome.
 *
 * Refused — with a whisper, never silently — when there is no snapshot to rewind
 * to, when the character has since gone terminal, or when another temptation has
 * already landed on top. Replaying under a later result would rewrite history the
 * table has already played past.
 */
async function reconcileReroll(actor, id, outcome, total) {
  const key = `${actorKey(actor)}:${id}:reroll`;
  if (recording.has(key)) return;
  recording.add(key);
  try {
    await withActorLock(actor, () => reconcileRerollInner(actor, id, outcome, total));
  } finally {
    recording.delete(key);
  }
}

async function reconcileRerollInner(actor, id, outcome, total) {
  const st = readIzir(actor);
  const idx = st.log.findIndex((e) => e.type === "temptation" && e.data?.id === id);
  if (idx < 0) return;

  const entry = st.log[idx];
  const prev = entry.data?.prev;
  if (!prev) return whisperReroll(actor, "SHARDS.Izir.RerollNoSnapshot");
  if (st.terminal) return whisperReroll(actor, "SHARDS.Izir.RerollTerminal");
  if (st.log.slice(idx + 1).some((e) => e.type === "temptation")) {
    return whisperReroll(actor, "SHARDS.Izir.RerollTooLate");
  }

  const oldDelta = Number(entry.data?.slideDelta) || 0;
  const corr = rerollCorrection(prev, oldDelta, outcome);

  // Retract this roll's own consequences wherever they sit — the slide is applied
  // before the temptation row is written, so they come BEFORE it — and rewrite the
  // row itself. Matching on the cause stamp rather than on position is what makes
  // that safe.
  const log = st.log
    .filter((e) => !(e.data?.cause === id && (e.type === "slide" || e.type === "level")))
    .map((e) =>
      e.type === "temptation" && e.data?.id === id
        ? { ...e, data: { ...e.data, outcome, total, slideDelta: corr.newDelta, rerolled: true } }
        : e,
    );
  await patchIzir(actor, { log });

  await rewindLevelSlide(actor, prev);
  let r = null;
  if (corr.newDelta > 0) {
    r = await applySlideChangeInner(actor, { delta: corr.newDelta, source: "temptation", cause: id });
  }

  const outcomeLabel = outcome ? game.i18n.localize(`SHARDS.Izir.Outcome.${outcome}`) : "—";
  const level = r?.level ?? prev.level;
  const name = esc(actor.name);
  let text = game.i18n.format("SHARDS.Izir.RerollApplied", {
    name,
    outcome: outcomeLabel,
    value: r?.slide ?? prev.slide,
    needed: slideNeeded(level),
  });
  if (r?.leveled) text += ` ${game.i18n.format("SHARDS.Izir.SlideLeveled", { name, level: r.level })}`;
  if (r?.atTenth) text += ` ${game.i18n.format("SHARDS.Izir.TenthReady", { name })}`;
  await whisperGM(actor, text);
  refreshIzirPanel();
}

/** GM-only note that a reroll could not be reconciled, and why. */
async function whisperReroll(actor, key) {
  await whisperGM(actor, game.i18n.format(key, { name: esc(actor.name) }));
}

async function whisperGM(actor, text) {
  // chatBubble: false — since 14.366 a roll-less message defaults to floating over
  // the speaker's token, and none of these cards are speech. (F36)
  await ChatMessage.create(
    {
      content: `<div class="izir-temptation-card"><p>${text}</p></div>`,
      whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
      speaker: ChatMessage.getSpeaker({ actor }),
    },
    { chatBubble: false },
  );
}

/**
 * GM-only report of what the failed save did to the track — including when it did
 * nothing. Silence on a refused slide, and "the slide moves +2: now 27 / 27" on a
 * bar that was already full, were both worse than saying so. (F19)
 */
async function whisperSlideReport(actor, delta, r, moved, prev) {
  // The actor name goes into chat HTML; a token named with a stray angle bracket
  // should not get to write markup there. (F12)
  const name = esc(actor.name);

  if (!r) {
    const key = prev.level < 1 ? "SHARDS.Izir.SlideInertLevel0" : "SHARDS.Izir.SlideInertTerminal";
    await whisperGM(actor, game.i18n.format(key, { name, delta }));
    return;
  }

  const needed = slideNeeded(r.level);
  let text = moved
    ? game.i18n.format("SHARDS.Izir.SlideMoved", { delta, value: r.slide, needed })
    : game.i18n.format("SHARDS.Izir.SlideCapped", { name, delta, value: r.slide, needed });
  if (r.leveled) text += ` ${game.i18n.format("SHARDS.Izir.SlideLeveled", { name, level: r.level })}`;
  if (r.atTenth) text += ` ${game.i18n.format("SHARDS.Izir.TenthReady", { name })}`;
  await whisperGM(actor, text);
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
  await ChatMessage.create(
    {
      content: `<div class="izir-temptation-card"><p class="izir-card-title"><i class="fa-solid fa-skull"></i> ${game.i18n.localize("SHARDS.Izir.SurgeTitle")}</p><p><em>${game.i18n.localize("SHARDS.Izir.SurgeText")}</em></p></div>`,
      whisper,
      speaker: ChatMessage.getSpeaker({ actor }),
    },
    { chatBubble: false },
  );
}

/** Chip action: a quiet reminder of the price to the player. */
export async function postReminder(actor) {
  const owners = playerOwners(actor);
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const whisper = [...new Set([...owners, ...gmIds])];
  await ChatMessage.create(
    {
      content: `<div class="izir-temptation-card"><p><em>${game.i18n.localize("SHARDS.Izir.RemindText")}</em></p></div>`,
      whisper,
      speaker: ChatMessage.getSpeaker({ actor }),
    },
    { chatBubble: false },
  );
}
