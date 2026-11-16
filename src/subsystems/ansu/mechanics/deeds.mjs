/**
 * Applying a deed to a bearer (0.8): loyalty and wrath move through the pure
 * `applyDeed`, the move is logged, and a level-up it earns is synced like any
 * other level change. GM side only (the capture and the panel run there).
 */

import { MODULE_ID } from "../../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "../state.mjs";
import { applyDeed } from "../logic/model.mjs";
import { loadDeeds } from "../content.mjs";
import { syncActor } from "../sync.mjs";
import { maybeSwapForLevel } from "../art.mjs";

const charLevelOf = (actor) => Math.max(0, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 0) || 0);

/**
 * Apply one deed by id. Writes the log entry
 * `{type: "deed", data: {deed, loyalty: [from, to], wrath: [from, to], level: [from, to]}, note}`.
 * Returns the applyDeed result, or null for an unknown deed.
 */
export async function recordDeed(actor, deedId, note = "") {
  let deed;
  try {
    deed = (await loadDeeds()).byId.get(deedId);
  } catch (err) {
    console.error(`${MODULE_ID} | ansu deeds could not load`, err);
    return null;
  }
  if (!deed) {
    console.warn(`${MODULE_ID} | unknown Ansu deed "${deedId}"`);
    return null;
  }
  const st = readAnsu(actor);
  const r = applyDeed(st, deed, { charLevel: charLevelOf(actor) });
  await patchAnsu(actor, { loyalty: r.state.loyalty, wrath: r.state.wrath, level: r.state.level });
  await appendLog(actor, "deed", { deed: deedId, loyalty: r.loyalty, wrath: r.wrath, level: r.level }, note);
  if (r.leveled) {
    await appendLog(actor, "level", { from: r.level[0], to: r.level[1] }, deed.label);
  }
  // Loyalty moves the Call DC the sheet quotes, so every deed resyncs.
  await syncActor(actor);
  if (r.leveled) await maybeSwapForLevel(actor, r.level[1]);
  return r;
}

/** Apply several deeds in order (a conflict's critical failure is a takeover plus a deed). */
export async function recordDeeds(actor, ids = [], note = "") {
  const out = [];
  for (const id of ids) out.push(await recordDeed(actor, id, note));
  return out;
}
