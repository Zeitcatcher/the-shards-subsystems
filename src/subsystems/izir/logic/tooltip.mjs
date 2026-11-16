/**
 * The ladder chip's hover text for one Izir entry. Pure, vitest-covered.
 *
 * Baked with the same context the panel's chip tags use (the bearer's own
 * immersion, at least 1) and the same injectNumbers the sheet uses, pack links
 * included. Banes show in full whether or not they are revealed: the panel is
 * GM-only.
 */

import { MAX_LEVEL } from "./model.mjs";
import { buildCtx, injectNumbers, hashString, stableStringify } from "./reconcile.mjs";

/**
 * @param {object} entry  a content entry
 * @param {object} state  the bearer's normalized Izir state (readIzir)
 * @param {{charLevel?: number}} opts
 * @returns {{entryId, name, level, cost, tag, text, key}}
 */
export function izirLadderTip(entry, state, { charLevel = 1 } = {}) {
  const level = entry.level ?? MAX_LEVEL;
  const ctx = buildCtx(charLevel, Math.max(1, state.level ?? 0));
  const a = entry.actionData ?? {};
  const isActive = entry.form === "action" || entry.form === "strike";
  const n = Math.trunc(Number(a.actions)) || 0;
  const cost = isActive && n > 0 ? "◆".repeat(n) : "";
  let tag = "";
  if (entry.chipTag) tag = injectNumbers(entry.chipTag, ctx);
  else if (a.recharge) tag = `R ${a.recharge}`;
  else if (a.frequency?.per === "day") tag = "1/day";
  const text = injectNumbers(entry.description ?? "", ctx);
  const key = `${entry.id}:${hashString(stableStringify({ ctx, cost, tag, text }))}`;
  return { entryId: entry.id, name: entry.name, level, cost, tag, text, key };
}
