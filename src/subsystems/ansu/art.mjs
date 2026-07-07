/**
 * Actor art swaps at tier thresholds (4 / 7 / 10) — the horn stages: broken →
 * regrowing → whole → Salbarium-adorned at Mastery. Captures the original
 * portrait + prototype-token art once before the first swap so a revert is
 * always possible, and propagates token art to already-placed tokens.
 */

import { MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "./state.mjs";
import { pickThresholdForLevel } from "./logic/art.mjs";

const artSwapOn = () => game.settings.get(MODULE_ID, SETTINGS.ANSU_ART_SWAP) === true;

/** Capture the current portrait + token art once (idempotent). */
export async function captureOriginalArt(actor) {
  const st = readAnsu(actor);
  if (st.art.original) return st.art.original;
  const original = {
    portrait: actor.img,
    token: actor.prototypeToken?.texture?.src ?? actor.img,
  };
  await patchAnsu(actor, { art: { original } });
  return original;
}

async function updatePlacedTokens(actor, src) {
  if (!src) return;
  for (const scene of game.scenes ?? []) {
    const toks = scene.tokens.filter((t) => t.actorId === actor.id);
    if (toks.length) {
      await scene.updateEmbeddedDocuments(
        "Token",
        toks.map((t) => ({ _id: t.id, "texture.src": src })),
      );
    }
  }
}

/** Apply a threshold's configured art. Returns true if anything changed. */
export async function applyThresholdArt(actor, threshold) {
  const st = readAnsu(actor);
  const slot = st.art.thresholds?.[threshold];
  if (!slot || (!slot.portrait && !slot.token)) return false;

  await captureOriginalArt(actor);
  const portrait = slot.portrait || actor.img;
  const token = slot.token || slot.portrait || actor.prototypeToken?.texture?.src;
  await actor.update({ img: portrait, "prototypeToken.texture.src": token });
  await updatePlacedTokens(actor, token);
  await patchAnsu(actor, { art: { applied: String(threshold) } });
  await appendLog(actor, "art", { threshold: String(threshold) });
  return true;
}

/** Restore the captured original art. Returns true if a revert happened. */
export async function revertArt(actor) {
  const st = readAnsu(actor);
  const orig = st.art.original;
  if (!orig) return false;
  await actor.update({ img: orig.portrait, "prototypeToken.texture.src": orig.token });
  await updatePlacedTokens(actor, orig.token);
  await patchAnsu(actor, { art: { applied: null } });
  await appendLog(actor, "art", { threshold: "revert" });
  return true;
}

/**
 * Auto-swap art to match a level (if the world setting allows it): apply the highest
 * configured threshold <= level, or revert when the level drops below all of them.
 */
export async function maybeSwapForLevel(actor, level) {
  if (!artSwapOn()) return;
  const st = readAnsu(actor);
  const target = pickThresholdForLevel(level, st.art.thresholds);
  if (target === st.art.applied) return;
  if (target) await applyThresholdArt(actor, target);
  else if (st.art.applied) await revertArt(actor);
}
