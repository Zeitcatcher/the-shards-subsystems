/**
 * Applying a deed to a bearer (0.8): loyalty and wrath move through the pure
 * `applyDeed`, the move is logged, and a level-up it earns is synced like any
 * other level change. GM side only (the capture and the panel run there).
 */

import { MODULE_ID } from "../../../core/constants.mjs";
import { isPrimaryGM } from "../../../core/platform.mjs";
import { readAnsu, patchAnsu, appendLog, isAttuned } from "../state.mjs";
import { applyDeed, nightRest, clampLoyalty, clampWrath } from "../logic/model.mjs";
import { loadDeeds } from "../content.mjs";
import { syncActor } from "../sync.mjs";
import { maybeSwapForLevel } from "../art.mjs";
import { rebuildValuesPage } from "../journal.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

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
  await rebuildValuesPage(actor);
  return r;
}

/** Apply several deeds in order (a conflict's critical failure is a takeover plus a deed). */
export async function recordDeeds(actor, ids = [], note = "") {
  const out = [];
  for (const id of ids) out.push(await recordDeed(actor, id, note));
  return out;
}

/**
 * The GM's +1 / -1 on a bar (0.8). Clamps, logs `{type: "adjust", data: {bar,
 * from, to}}` and resyncs (loyalty moves the Call DC the sheet quotes). A raise
 * of loyalty runs the same level-up check as a deed (step E ruling): reaching 10
 * under the gate with wrath 2 or less raises the level and resets the bars.
 * Returns the new bar value, or null when nothing moved.
 */
export async function adjustBar(actor, bar, delta) {
  if (bar !== "loyalty" && bar !== "wrath") return null;
  const st = readAnsu(actor);
  const from = bar === "loyalty" ? st.loyalty : st.wrath;
  const to = bar === "loyalty" ? clampLoyalty(from + delta) : clampWrath(from + delta);
  if (to === from) return null;
  if (bar === "loyalty" && to > from) {
    const r = applyDeed(st, { loyalty: to - from }, { charLevel: charLevelOf(actor) });
    if (r.leveled) {
      await patchAnsu(actor, { loyalty: r.state.loyalty, wrath: r.state.wrath, level: r.state.level });
      await appendLog(actor, "adjust", { bar, from, to });
      await appendLog(actor, "level", { from: r.level[0], to: r.level[1] });
      await syncActor(actor);
      await maybeSwapForLevel(actor, r.level[1]);
      await rebuildValuesPage(actor);
      return r.state.loyalty;
    }
  }
  await patchAnsu(actor, { [bar]: to });
  await appendLog(actor, "adjust", { bar, from, to });
  await syncActor(actor);
  return to;
}

/**
 * A night's rest (0.8): wrath -1 unless loyalty is 0, a rest lockout cleared,
 * the agreed takeover available again. A rest that moves wrath writes the
 * `night` deed line; one that moves nothing writes no log entry. Returns
 * `{wrath: [from, to], lockoutCleared, consentReset}`, or null for no bearer.
 */
export async function restForNight(actor) {
  if (!isAttuned(actor)) return null;
  const st = readAnsu(actor);
  const next = nightRest(st);
  const out = {
    wrath: [st.wrath, next.wrath],
    lockoutCleared: Boolean(st.lockout) && !next.lockout,
    consentReset: st.consentUsed === true,
  };
  if (!out.lockoutCleared && !out.consentReset && next.wrath === st.wrath) return out;
  await patchAnsu(actor, { wrath: next.wrath, lockout: next.lockout, consentUsed: false });
  if (next.wrath !== st.wrath) {
    await appendLog(actor, "deed", {
      deed: "night",
      loyalty: [st.loyalty, st.loyalty],
      wrath: out.wrath,
      level: [st.level, st.level],
    });
    await rebuildValuesPage(actor);
  }
  await syncActor(actor);
  return out;
}

/**
 * pf2e's Rest for the Night posts its chat message with the creation option
 * `restForTheNight: true` (ChatMessagePF2e._onCreate in the 8.2.0 mirror reads
 * it), one message per resting actor. The primary GM runs the rest for an
 * attuned speaker. The panel button calls restForNight directly.
 */
export function onRestMessage(message, options) {
  if (!options?.restForTheNight) return null;
  if (!isPrimaryGM()) return null;
  const actor = message?.speakerActor ?? ChatMessage.getSpeakerActor?.(message?.speaker) ?? null;
  if (!actor || !isAttuned(actor)) return null;
  return restForNight(actor)
    .then((r) => {
      refreshAnsuPanel();
      return r;
    })
    .catch((err) => console.error(`${MODULE_ID} | ansu night's rest`, err));
}

export function registerRestHooks() {
  Hooks.on("createChatMessage", onRestMessage);
}
