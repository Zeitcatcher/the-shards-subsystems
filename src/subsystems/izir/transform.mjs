/**
 * Level lifecycle: the shared immersion/slide mutation helpers, and the level-10
 * fork. Reaching immersion 10 is not a plain step — the GM chooses the character's
 * fate: consumed into a Ниневеш, or full mastery (Подчинение). Subjugation
 * auto-suppresses every price (reason "subjugation"; the GM can restore scars) and
 * unlocks the gated capstone; Nineveh strips everything to the terminal marker.
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readIzir, patchIzir, appendLog, withActorLock } from "./state.mjs";
import { loadContent } from "./content.mjs";
import { syncActor } from "./sync.mjs";
import { maybeSwapForLevel } from "./art.mjs";
import { clampLevel, applySlide, clampSlideForLevel, MAX_LEVEL } from "./logic/model.mjs";

/**
 * Set immersion directly (stepper, token badge). Clamps to 0..9 — entering 10 goes
 * through the fork only. Slide points are clamped to the new bar.
 */
export async function setImmersion(actor, next, note = "") {
  return withActorLock(actor, () => setImmersionInner(actor, next, note));
}

async function setImmersionInner(actor, next, note) {
  const st = readIzir(actor);
  if (st.terminal) return;
  const to = clampLevel(Math.min(next, MAX_LEVEL - 1));
  if (to === st.level) return;
  const slide = clampSlideForLevel(st.slide ?? 0, to);
  await patchIzir(actor, { level: to, slide });
  await appendLog(actor, "level", { from: st.level, to }, note);
  await syncActor(actor);
  await maybeSwapForLevel(actor, to);
}

/**
 * Move the slide (delta or absolute set). Overflow raises immersion automatically
 * (with carry); a full bar at 9 only signals the Tenth Step. Returns the result of
 * the pure applySlide, or null when the slide is inactive.
 */
export async function applySlideChange(actor, opts = {}) {
  return withActorLock(actor, () => applySlideChangeInner(actor, opts));
}

/**
 * The body of applySlideChange, without the lock. Only for callers that already
 * hold it — taking it twice on one chain would wedge the queue.
 */
export async function applySlideChangeInner(actor, { delta = 0, set, source = "gm", cause = null } = {}) {
  const st = readIzir(actor);
  if (st.terminal || st.level < 1 || st.level >= MAX_LEVEL) return null;

  const r = applySlide(st.level, st.slide ?? 0, delta, set !== undefined ? { set } : {});
  if (r.level === st.level && r.slide === (st.slide ?? 0)) return r;

  await patchIzir(actor, { level: r.level, slide: r.slide });
  // `cause` ties these entries back to the roll that produced them, so a reroll can
  // find and retract exactly its own consequences instead of guessing by position.
  await appendLog(actor, "slide", { from: st.slide ?? 0, to: r.slide, level: r.level, source, cause });

  if (r.leveled) {
    await appendLog(actor, "level", { from: st.level, to: r.level, cause }, game.i18n.localize("SHARDS.Izir.SlideNote"));
    await syncActor(actor);
    await maybeSwapForLevel(actor, r.level);
    ui.notifications?.info(game.i18n.format("SHARDS.Izir.SlideLeveled", { name: actor.name, level: r.level }));
  }
  if (r.atTenth) {
    ui.notifications?.warn(game.i18n.format("SHARDS.Izir.TenthReady", { name: actor.name }));
  }
  return r;
}

/**
 * Put level and slide back to a snapshot, then bring items and art in line. No
 * "level" log entry: this is history being corrected, not a new step on the track.
 * Only the reroll reconciliation uses it.
 */
export async function rewindLevelSlide(actor, snapshot) {
  const st = readIzir(actor);
  const to = clampLevel(snapshot?.level ?? 0);
  const slide = Math.max(0, Math.trunc(Number(snapshot?.slide)) || 0);
  if (st.level === to && (st.slide ?? 0) === slide) return;
  await patchIzir(actor, { level: to, slide });
  await syncActor(actor);
  await maybeSwapForLevel(actor, to);
}

/**
 * The prompt body. Below immersion 9 it says so plainly rather than pretending the
 * character has walked the whole track — the early fork is a deliberate GM
 * override, not an accident to be papered over. (F13)
 */
function forkPrompt(actor, level, path = null) {
  const name = foundry.utils.escapeHTML(actor.name);
  const early = level < MAX_LEVEL - 1;
  const lead = early
    ? game.i18n.format("SHARDS.Izir.ForkPromptEarly", { name, level })
    : game.i18n.format("SHARDS.Izir.ForkPrompt", { name });
  const chosen = path
    ? `<p class="izir-fork-chosen"><strong>${game.i18n.localize(
        path === "nineveh" ? "SHARDS.Izir.ForkNineveh" : "SHARDS.Izir.ForkSubjugated",
      )}</strong></p>`
    : "";
  return `<div class="izir-fork">
    <p>${lead}</p>
    ${chosen}
    <p class="izir-fork-warn">${game.i18n.localize("SHARDS.Izir.ForkWarn")}</p>
  </div>`;
}

async function openForkDialog(actor, level) {
  const content = forkPrompt(actor, level);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SHARDS.Izir.ForkTitle"), icon: "fa-solid fa-skull" },
    classes: ["the-shards-subsystems", "izir-fork-dialog"],
    content,
    buttons: [
      { action: "nineveh", label: game.i18n.localize("SHARDS.Izir.ForkNineveh"), icon: "fa-solid fa-skull", class: "izir-fork-nineveh" },
      { action: "subjugated", label: game.i18n.localize("SHARDS.Izir.ForkSubjugated"), icon: "fa-solid fa-crown", class: "izir-fork-subjugated" },
      { action: "cancel", label: game.i18n.localize("SHARDS.Izir.Cancel"), icon: "fa-solid fa-xmark" },
    ],
    modal: true,
    rejectClose: false,
  }).catch(() => null);
  return choice === "nineveh" || choice === "subjugated" ? choice : null;
}

async function postGuidance(actor, path) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const key = path === "subjugated" ? "SHARDS.Izir.GuidanceSubjugated" : "SHARDS.Izir.GuidanceNineveh";
  await ChatMessage.create(
    {
      content: `<div class="izir-temptation-card"><p class="izir-card-title"><i class="fa-solid fa-eye"></i> ${game.i18n.localize("SHARDS.Izir.ForkTitle")}</p><p>${game.i18n.localize(key)}</p></div>`,
      whisper: gmIds,
      speaker: ChatMessage.getSpeaker({ actor }),
    },
    { chatBubble: false }, // not speech (F36)
  );
}

async function applyNineveh(actor) {
  // A pending temptation dies with the character; the panel hides the clear
  // button for a consumed actor, so an uncleared one left an hourglass dot on
  // the roster forever. (F20)
  await patchIzir(actor, { level: 10, terminal: "nineveh", slide: 0, pendingTemptation: null });
  await appendLog(actor, "transform", { path: "nineveh" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "nineveh");
}

async function applySubjugation(actor, content) {
  const st = readIzir(actor);
  const baneFamilies = [...new Set(content.entries.filter((e) => e.kind === "bane").map((e) => e.family))];
  const existing = new Set(st.suppressed.map((s) => s.id));
  const suppressed = [...st.suppressed];
  for (const fam of baneFamilies) {
    if (!existing.has(fam)) suppressed.push({ id: fam, reason: "subjugation", at: Date.now() });
  }
  await patchIzir(actor, { level: 10, terminal: "subjugated", suppressed, slide: 0, pendingTemptation: null });
  await appendLog(actor, "transform", { path: "subjugated" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "subjugated");
}

const FORK_PATHS = new Set(["nineveh", "subjugated"]);

/**
 * Apply the Tenth Step. With no `preselect` the GM picks from both fates; a ladder
 * chip passes the fate it stands for and only asks to confirm.
 * Returns true if a fate was chosen.
 */
export async function triggerFork(actor, preselect = null) {
  const st = readIzir(actor);
  if (st.terminal) return false;

  // Load the content BEFORE asking. Subjugation suppresses every price, and with a
  // broken data file it used to commit the terminal with an empty suppression list
  // while the whisper claimed otherwise — then compose every bane live on a
  // "Mastered" character once the file was repaired. (F30)
  const content = await loadContent().catch(() => null);
  if (!content) {
    ui.notifications?.error(game.i18n.localize("SHARDS.Izir.ContentError"));
    return false;
  }

  const level = clampLevel(st.level);

  let choice = null;
  if (preselect && FORK_PATHS.has(preselect)) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("SHARDS.Izir.ForkTitle"), icon: "fa-solid fa-skull" },
      classes: ["the-shards-subsystems", "izir-fork-dialog"],
      content: forkPrompt(actor, level, preselect),
    }).catch(() => false);
    if (ok) choice = preselect;
  } else {
    choice = await openForkDialog(actor, level);
  }

  if (!choice) return false;
  return withActorLock(actor, async () => {
    if (readIzir(actor).terminal) return false; // decided while the dialog was open
    if (choice === "nineveh") await applyNineveh(actor);
    else await applySubjugation(actor, content);
    return true;
  });
}
