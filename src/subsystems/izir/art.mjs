/**
 * Actor art swaps at tier thresholds (4 / 7 / 10). Captures the original portrait +
 * prototype-token art once before the first swap so a revert is always possible, and
 * propagates the token art to already-placed tokens on every scene.
 */

import { MODULE_ID, SETTINGS } from "../../core/constants.mjs";
import { readIzir, patchIzir, appendLog } from "./state.mjs";
import { pickThresholdForLevel } from "./logic/art.mjs";

const artSwapOn = () => game.settings.get(MODULE_ID, SETTINGS.IZIR_ART_SWAP) === true;

/** The token art source, synthetic-actor aware. */
function currentTokenSrc(actor) {
  return actor.isToken ? actor.token?.texture?.src : actor.prototypeToken?.texture?.src;
}

/** Write portrait (+ prototype token for world actors) without touching a synthetic delta's missing prototype. */
async function updateActorArt(actor, portrait, token) {
  if (actor.isToken) await actor.update({ img: portrait });
  else await actor.update({ img: portrait, "prototypeToken.texture.src": token });
}

/** Capture the current portrait + token art once (idempotent). */
export async function captureOriginalArt(actor) {
  const st = readIzir(actor);
  if (st.art.original) return st.art.original;
  const original = {
    portrait: actor.img,
    token: currentTokenSrc(actor) ?? actor.img,
  };
  await patchIzir(actor, { art: { original } });
  return original;
}

async function updatePlacedTokens(actor, src) {
  if (!src) return;
  // Unlinked (synthetic) token actors are never matched by actorId — update their
  // own token document directly. Linked actors update every placed token. (C6)
  if (actor.isToken) {
    if (actor.token) await actor.token.update({ "texture.src": src });
    return;
  }
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
  const st = readIzir(actor);
  const slot = st.art.thresholds?.[threshold];
  if (!slot || (!slot.portrait && !slot.token)) return false;

  await captureOriginalArt(actor);
  const portrait = slot.portrait || actor.img;
  const token = slot.token || slot.portrait || currentTokenSrc(actor);
  await updateActorArt(actor, portrait, token);
  await updatePlacedTokens(actor, token);
  // Applying by hand lifts the hold a manual revert put on: the GM has said, in
  // the clearest way available, that they want the swap after all. (F25)
  await patchIzir(actor, { art: { applied: String(threshold), hold: false } });
  await appendLog(actor, "art", { threshold: String(threshold) });
  return true;
}

/**
 * Restore the captured original art. Returns true if a revert happened.
 *
 * The capture is released with it. Keeping a stale `original` meant that a GM who
 * reverted, set new base art, then swapped and reverted again got the FIRST
 * portrait stamped back over the new one, on the actor and every token, with no
 * log line saying where it came from. The early return in `captureOriginalArt`
 * still protects a 4 → 7 chain, because nothing reverts in between. (F25)
 */
export async function revertArt(actor, { hold = false } = {}) {
  const st = readIzir(actor);
  const orig = st.art.original;
  if (!orig) return false;
  await updateActorArt(actor, orig.portrait, orig.token);
  await updatePlacedTokens(actor, orig.token);
  await patchIzir(actor, { art: { applied: null, original: null, hold } });
  await appendLog(actor, "art", { threshold: "revert" });
  return true;
}

/**
 * Auto-swap art to match a level (if the world setting allows it): apply the highest
 * configured threshold <= level, or revert when the level drops below all of them.
 */
export async function maybeSwapForLevel(actor, level) {
  if (!artSwapOn()) return;
  const st = readIzir(actor);
  // A manual revert holds. The GM who put a bearer's own face back for a social
  // scene at immersion 8 did not want the next failed save to stamp the horror
  // art on again unasked. The hold lifts when they apply art by hand or edit a
  // threshold row. (F25)
  if (st.art.hold) return;
  const target = pickThresholdForLevel(level, st.art.thresholds);
  if (target === st.art.applied) return;
  if (target) await applyThresholdArt(actor, target);
  else if (st.art.applied) await revertArt(actor);
}
