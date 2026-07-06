/**
 * Level lifecycle: the shared immersion/slide mutation helpers, and the level-10
 * fork. Reaching immersion 10 is not a plain step — the GM chooses the character's
 * fate: consumed into a Ниневеш, or full mastery (Подчинение). Subjugation
 * auto-suppresses every price (reason "subjugation"; the GM can restore scars) and
 * unlocks the gated capstone; Nineveh strips everything to the terminal marker.
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readIzir, patchIzir, appendLog } from "./state.mjs";
import { loadContent } from "./content.mjs";
import { syncActor } from "./sync.mjs";
import { maybeSwapForLevel } from "./art.mjs";
import { clampLevel, applySlide, slideNeeded, MAX_LEVEL } from "./logic/model.mjs";

/**
 * Set immersion directly (stepper, token badge). Clamps to 0..9 — entering 10 goes
 * through the fork only. Slide points are clamped to the new bar.
 */
export async function setImmersion(actor, next, note = "") {
  const st = readIzir(actor);
  if (st.terminal) return;
  const to = clampLevel(Math.min(next, MAX_LEVEL - 1));
  if (to === st.level) return;
  const slide = Math.min(st.slide ?? 0, slideNeeded(to) || 0);
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
export async function applySlideChange(actor, { delta = 0, set, source = "gm" } = {}) {
  const st = readIzir(actor);
  if (st.terminal || st.level < 1 || st.level >= MAX_LEVEL) return null;

  const r = applySlide(st.level, st.slide ?? 0, delta, set !== undefined ? { set } : {});
  if (r.level === st.level && r.slide === (st.slide ?? 0)) return r;

  await patchIzir(actor, { level: r.level, slide: r.slide });
  await appendLog(actor, "slide", { from: st.slide ?? 0, to: r.slide, level: r.level, source });

  if (r.leveled) {
    await appendLog(actor, "level", { from: st.level, to: r.level }, game.i18n.localize("SHARDS.Izir.SlideNote"));
    await syncActor(actor);
    await maybeSwapForLevel(actor, r.level);
    ui.notifications?.info(game.i18n.format("SHARDS.Izir.SlideLeveled", { name: actor.name, level: r.level }));
  }
  if (r.atTenth) {
    ui.notifications?.warn(game.i18n.format("SHARDS.Izir.TenthReady", { name: actor.name }));
  }
  return r;
}

async function openForkDialog(actor) {
  const content = `<div class="izir-fork">
    <p>${game.i18n.format("SHARDS.Izir.ForkPrompt", { name: foundry.utils.escapeHTML(actor.name) })}</p>
    <p class="izir-fork-warn">${game.i18n.localize("SHARDS.Izir.ForkWarn")}</p>
  </div>`;
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
  await ChatMessage.create({
    content: `<div class="izir-temptation-card"><p class="izir-card-title"><i class="fa-solid fa-eye"></i> ${game.i18n.localize("SHARDS.Izir.ForkTitle")}</p><p>${game.i18n.localize(key)}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

async function applyNineveh(actor) {
  await patchIzir(actor, { level: 10, terminal: "nineveh", slide: 0 });
  await appendLog(actor, "transform", { path: "nineveh" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "nineveh");
}

async function applySubjugation(actor) {
  const content = await loadContent().catch(() => null);
  const st = readIzir(actor);
  const baneFamilies = content
    ? [...new Set(content.entries.filter((e) => e.kind === "bane").map((e) => e.family))]
    : [];
  const existing = new Set(st.suppressed.map((s) => s.id));
  const suppressed = [...st.suppressed];
  for (const fam of baneFamilies) {
    if (!existing.has(fam)) suppressed.push({ id: fam, reason: "subjugation", at: Date.now() });
  }
  await patchIzir(actor, { level: 10, terminal: "subjugated", suppressed, slide: 0 });
  await appendLog(actor, "transform", { path: "subjugated" });
  await syncActor(actor);
  await maybeSwapForLevel(actor, 10);
  await postGuidance(actor, "subjugated");
}

/**
 * Open the fork dialog and apply the chosen fate. Returns true if a fate was chosen.
 */
export async function triggerFork(actor) {
  const choice = await openForkDialog(actor);
  if (!choice) return false;
  if (choice === "nineveh") await applyNineveh(actor);
  else await applySubjugation(actor);
  return true;
}
