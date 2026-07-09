/**
 * Level lifecycle: attunement/climb mutation helpers and the terminals. Reaching
 * attunement 10 is a table moment, never a die roll — the GM chooses: Subjugation
 * (Mastery: permanent Communion, capstone unlocked) or Taken (the Ansu wins the
 * body forever; the character becomes a GM-run NPC at full strength). Taken is
 * also reachable at ANY attunement from the panel footer — the Ansu doesn't have
 * to wait for level 10 if the bearer's will breaks.
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "./state.mjs";
import { syncActor, readDials } from "./sync.mjs";
import { maybeSwapForLevel } from "./art.mjs";
import { clampLevel, applyClimb, climbNeeded, MAX_LEVEL } from "./logic/model.mjs";

/**
 * Set attunement directly (stepper, token badge). Clamps to 0..9 — entering 10
 * goes through the fork only. Climb points are clamped to the new bar.
 */
export async function setAttunement(actor, next, note = "") {
  const st = readAnsu(actor);
  if (st.terminal) return;
  const to = clampLevel(Math.min(next, MAX_LEVEL - 1));
  if (to === st.level) return;
  const d = readDials();
  const climb = Math.min(st.climb ?? 0, climbNeeded(to, d.climbBase, d.climbStep) || 0);
  await patchAnsu(actor, { level: to, climb });
  await appendLog(actor, "level", { from: st.level, to }, note);
  await syncActor(actor);
  await maybeSwapForLevel(actor, to);
}

/**
 * Move the Climb (delta or absolute set). Overflow raises attunement automatically
 * (with carry); a full bar at 9 only signals the Tenth Step. Returns the result of
 * the pure applyClimb, or null when the climb is inactive.
 */
export async function applyClimbChange(actor, { delta = 0, set, source = "gm" } = {}) {
  const st = readAnsu(actor);
  if (st.terminal || st.level < 1 || st.level >= MAX_LEVEL) return null;

  const d = readDials();
  const opts = { base: d.climbBase, step: d.climbStep };
  if (set !== undefined) opts.set = set;
  const r = applyClimb(st.level, st.climb ?? 0, delta, opts);
  if (r.level === st.level && r.climb === (st.climb ?? 0)) return r;

  await patchAnsu(actor, { level: r.level, climb: r.climb });
  await appendLog(actor, "climb", { from: st.climb ?? 0, to: r.climb, level: r.level, source });

  if (r.leveled) {
    await appendLog(actor, "level", { from: st.level, to: r.level }, game.i18n.localize("SHARDS.Ansu.ClimbNote"));
    await syncActor(actor);
    await maybeSwapForLevel(actor, r.level);
    ui.notifications?.info(game.i18n.format("SHARDS.Ansu.ClimbLeveled", { name: actor.name, level: r.level }));
  }
  if (r.atTenth) {
    ui.notifications?.warn(game.i18n.format("SHARDS.Ansu.TenthReady", { name: actor.name }));
  }
  return r;
}

async function openForkDialog(actor) {
  const content = `<div class="ansu-fork">
    <p>${game.i18n.format("SHARDS.Ansu.ForkPrompt", { name: foundry.utils.escapeHTML(actor.name) })}</p>
    <p class="ansu-fork-warn">${game.i18n.localize("SHARDS.Ansu.ForkWarn")}</p>
  </div>`;
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SHARDS.Ansu.ForkTitle"), icon: "fa-solid fa-crown" },
    classes: ["the-shards-subsystems", "ansu-fork-dialog"],
    content,
    buttons: [
      { action: "subjugated", label: game.i18n.localize("SHARDS.Ansu.ForkSubjugated"), icon: "fa-solid fa-crown", class: "ansu-fork-subjugated" },
      { action: "taken", label: game.i18n.localize("SHARDS.Ansu.ForkTaken"), icon: "fa-solid fa-skull", class: "ansu-fork-taken" },
      { action: "cancel", label: game.i18n.localize("SHARDS.Ansu.Cancel"), icon: "fa-solid fa-xmark" },
    ],
    modal: true,
    rejectClose: false,
  }).catch(() => null);
  return choice === "subjugated" || choice === "taken" ? choice : null;
}

async function postGuidance(actor, path) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  const key = path === "subjugated" ? "SHARDS.Ansu.GuidanceSubjugated" : "SHARDS.Ansu.GuidanceTaken";
  await ChatMessage.create({
    content: `<div class="ansu-card"><p class="ansu-card-title"><i class="fa-solid fa-crown"></i> ${game.i18n.localize("SHARDS.Ansu.ForkTitle")}</p><p>${game.i18n.localize(key)}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Mastery: permanent Communion (on by default), no saves, capstone unlocked. */
async function applySubjugation(actor) {
  await patchAnsu(actor, {
    level: 10,
    terminal: "subjugated",
    climb: 0,
    communion: { mode: "active", rounds: null },
    pendingRelease: null,
    pendingCall: null,
    seizure: null,
  });
  await appendLog(actor, "transform", { path: "subjugated" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "subjugated");
}

/** The Ansu wins: the character is an NPC now, every boon permanently active. */
async function applyTaken(actor) {
  await patchAnsu(actor, {
    level: 10,
    terminal: "taken",
    climb: 0,
    communion: { mode: "active", rounds: null },
    pendingRelease: null,
    pendingCall: null,
    seizure: null,
  });
  await appendLog(actor, "transform", { path: "taken" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "taken");
}

/**
 * Open the fork dialog and apply the chosen fate. Returns true if a fate was chosen.
 */
export async function triggerFork(actor) {
  const choice = await openForkDialog(actor);
  if (!choice) return false;
  if (choice === "subjugated") await applySubjugation(actor);
  else await applyTaken(actor);
  return true;
}

/**
 * Declare the Ansu victorious at any attunement (panel footer, confirm dialog).
 * Returns true if applied.
 */
export async function triggerTaken(actor) {
  const st = readAnsu(actor);
  if (st.terminal) return false;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("SHARDS.Ansu.TakenTitle") },
    content: `<p>${game.i18n.format("SHARDS.Ansu.TakenConfirm", { name: foundry.utils.escapeHTML(actor.name) })}</p>`,
  }).catch(() => false);
  if (!ok) return false;
  await applyTaken(actor);
  return true;
}
