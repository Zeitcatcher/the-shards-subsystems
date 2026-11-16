/**
 * The ladder chip's hover text for one Ansu entry. Pure, vitest-covered.
 *
 * The description is baked exactly as the sheet bakes it (injectNumbers over the
 * same context), with one difference the panel already makes for its chip tags:
 * a locked row previews its numbers at its own unlock level (ladderCtxLevel).
 * The "current" level is what the sheet uses (unlockFor), so a takeover shows
 * the takeover's numbers. The DC tokens are never hidden: the panel is GM-only.
 */

import { MAX_LEVEL } from "./model.mjs";
import {
  buildCtx,
  injectNumbers,
  ladderCtxLevel,
  communionMode,
  unlockFor,
  actionDataFor,
  costGlyph,
  bakeActionData,
  frequencyTag,
  hashString,
  stableStringify,
} from "./reconcile.mjs";

/**
 * @param {object} entry  a content entry
 * @param {object} state  the bearer's normalized Ansu state (readAnsu)
 * @param {{charLevel?: number, dials?: object}} opts
 * @returns {{entryId, name, level, cost, tag, text, key}}
 */
export function ansuLadderTip(entry, state, { charLevel = 1, dials = {} } = {}) {
  const level = entry.level ?? MAX_LEVEL;
  const { level: current } = unlockFor(state, communionMode(state));
  const at = ladderCtxLevel({ rowLevel: level, level: current });
  const ctx = buildCtx(charLevel, at, dials, { loyalty: state.loyalty });
  const src = actionDataFor(entry, state);
  const cost = costGlyph(src);
  const tag = entry.chipTag ? injectNumbers(entry.chipTag, ctx) : frequencyTag(bakeActionData(src, ctx));
  const text = injectNumbers(entry.description ?? "", ctx);
  const key = `${entry.id}:${hashString(stableStringify({ ctx, cost, tag, text }))}`;
  return { entryId: entry.id, name: entry.name, level, cost, tag, text, key };
}
