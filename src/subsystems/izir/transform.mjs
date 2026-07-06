/**
 * The level-10 fork. Reaching immersion 10 is not a plain step — the GM chooses the
 * character's fate: consumed into a Ниневеш, or full mastery (Подчинение). Subjugation
 * auto-suppresses every price (reason "subjugation"; the GM can restore scars) and
 * unlocks the gated capstone; Nineveh strips everything to the terminal marker.
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readIzir, patchIzir, appendLog } from "./state.mjs";
import { loadContent } from "./content.mjs";
import { syncActor } from "./sync.mjs";
import { maybeSwapForLevel } from "./art.mjs";

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
  await patchIzir(actor, { level: 10, terminal: "nineveh" });
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
  await patchIzir(actor, { level: 10, terminal: "subjugated", suppressed });
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
