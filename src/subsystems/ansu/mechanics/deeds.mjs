/**
 * Applying a deed to a bearer (0.8): loyalty and wrath move through the pure
 * `applyDeed`, the move is logged, and a level-up it earns is synced like any
 * other level change. GM side only (the capture and the panel run there).
 */

import { MODULE_ID } from "../../../core/constants.mjs";
import { isPrimaryGM } from "../../../core/platform.mjs";
import { mutateAnsu, logEntry, withExtra, flushExtra, isAttuned } from "../state.mjs";
import { applyDeed, nightRest, clampLoyalty, clampWrath } from "../logic/model.mjs";
import { loadDeeds } from "../content.mjs";
import { syncActor } from "../sync.mjs";
import { maybeSwapForLevel } from "../art.mjs";
import { rebuildValuesPage } from "../journal.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

/** The Ansu holds the body: level-ups wait for the return (review ruling 9). */
const isHeld = (st) => st?.communion?.mode === "seized";

const charLevelOf = (actor) => Math.max(0, Number(actor?.system?.details?.level?.value ?? actor?.level ?? 0) || 0);

/**
 * Fold deeds through `applyDeed` in memory, in order. `deeds` is a list of
 * `{id, deed}`. Each writes the log row
 * `{type: "deed", data: {deed, loyalty: [from, to], wrath: [from, to], level: [from, to]}, note}`,
 * and a deed that raises the level adds a `level` row noted with the deed's
 * label. Returns `{state, results, logs, leveled, level}`. Pure.
 */
export function foldDeeds(st, deeds, { charLevel = 0, note = "" } = {}) {
  let cur = st;
  const results = [];
  const logs = [];
  let leveled = false;
  for (const { id, deed } of deeds) {
    const r = applyDeed(cur, deed, { charLevel, holdLevel: isHeld(cur) });
    logs.push(logEntry("deed", { deed: id, loyalty: r.loyalty, wrath: r.wrath, level: r.level }, note));
    if (r.leveled) {
      logs.push(logEntry("level", { from: r.level[0], to: r.level[1] }, deed.label));
      leveled = true;
    }
    results.push(r);
    cur = r.state;
  }
  return { state: cur, results, logs, leveled, level: cur.level };
}

/** The bars and level a fold leaves, as a patch. */
const barsPatch = (state) => ({ loyalty: state.loyalty, wrath: state.wrath, level: state.level });

/**
 * Apply one deed by id. Returns the applyDeed result, or null for an unknown deed.
 */
export async function recordDeed(actor, deedId, note = "") {
  return (await recordDeeds(actor, [deedId], note))[0] ?? null;
}

/**
 * The level-up check on its own (review ruling 9): a takeover holds every
 * level-up, and the return runs this once. Reaching loyalty 10 under the gate
 * with wrath 2 or less raises the level and resets the bars, as a deed would.
 * Returns true when the level rose.
 */
export async function checkLevelUp(actor) {
  const r = await mutateAnsu(actor, (st) => {
    if (isHeld(st)) return null;
    const r = applyDeed(st, {}, { charLevel: charLevelOf(actor) });
    if (!r.leveled) return null;
    return { patch: barsPatch(r.state), log: logEntry("level", { from: r.level[0], to: r.level[1] }), result: r };
  });
  if (!r) return false;
  await syncActor(actor);
  await maybeSwapForLevel(actor, r.level[1]);
  await rebuildValuesPage(actor);
  return true;
}

/**
 * Apply several deeds in order (a conflict's critical failure is a takeover plus
 * a deed): every deed, its log rows and the caller's `extra` write land in ONE
 * update, followed by one sync, one art check and one values-page rebuild
 * (0.8.0). `extra` (`{patch, log}`) is the caller's own record, written first in
 * the log; it is written even when no deed applies. `sync: false` leaves the
 * sync to a caller that syncs right after (a takeover). Returns the applyDeed
 * result per id, null for an unknown one.
 */
export async function recordDeeds(actor, ids = [], note = "", { extra = null, sync = true } = {}) {
  let index;
  try {
    index = (await loadDeeds()).byId;
  } catch (err) {
    console.error(`${MODULE_ID} | ansu deeds could not load`, err);
    await flushExtra(actor, extra);
    return ids.map(() => null);
  }
  const known = [];
  for (const id of ids) {
    const deed = index.get(id);
    if (deed) known.push({ id, deed });
    else console.warn(`${MODULE_ID} | unknown Ansu deed "${id}"`);
  }
  if (!known.length) {
    await flushExtra(actor, extra);
    return ids.map(() => null);
  }
  const fold = await mutateAnsu(actor, (st) => {
    const f = foldDeeds(st, known, { charLevel: charLevelOf(actor), note });
    const w = withExtra(extra, barsPatch(f.state), f.logs);
    return { patch: w.patch, log: w.log, update: w.update, result: f };
  });
  // Loyalty moves the Call DC the sheet quotes, so every deed resyncs.
  if (sync) await syncActor(actor);
  if (fold.leveled) await maybeSwapForLevel(actor, fold.level);
  await rebuildValuesPage(actor);
  let i = 0;
  return ids.map((id) => (index.get(id) ? fold.results[i++] : null));
}

/**
 * The GM's +1 / -1 on a bar (0.8). Clamps, logs `{type: "adjust", data: {bar,
 * from, to}}` and resyncs (loyalty moves the Call DC the sheet quotes). A raise
 * of loyalty runs the same level-up check as a deed (step E ruling): reaching 10
 * under the gate with wrath 2 or less raises the level and resets the bars.
 * Read and written under the flag lock, so two quick clicks both count.
 * Returns the new bar value, or null when nothing moved.
 */
export async function adjustBar(actor, bar, delta) {
  if (bar !== "loyalty" && bar !== "wrath") return null;
  const r = await mutateAnsu(actor, (st) => {
    const from = bar === "loyalty" ? st.loyalty : st.wrath;
    const to = bar === "loyalty" ? clampLoyalty(from + delta) : clampWrath(from + delta);
    if (to === from) return null;
    if (bar === "loyalty" && to > from) {
      const d = applyDeed(st, { loyalty: to - from }, { charLevel: charLevelOf(actor), holdLevel: isHeld(st) });
      if (d.leveled) {
        return {
          patch: barsPatch(d.state),
          log: [logEntry("adjust", { bar, from, to }), logEntry("level", { from: d.level[0], to: d.level[1] })],
          result: { value: d.state.loyalty, level: d.level[1] },
        };
      }
    }
    return { patch: { [bar]: to }, log: logEntry("adjust", { bar, from, to }), result: { value: to, level: null } };
  });
  if (!r) return null;
  await syncActor(actor);
  if (r.level !== null) {
    await maybeSwapForLevel(actor, r.level);
    await rebuildValuesPage(actor);
  }
  return r.value;
}

/**
 * A night's rest (0.8): wrath -1 unless loyalty is 0, a rest lockout cleared,
 * the agreed takeover available again. A rest that moves wrath writes the
 * `night` deed line; one that moves nothing writes no log entry. Returns
 * `{wrath: [from, to], lockoutCleared, consentReset}`, or null for no bearer.
 */
export async function restForNight(actor) {
  if (!isAttuned(actor)) return null;
  const out = await mutateAnsu(actor, (st) => {
    const next = nightRest(st);
    const res = {
      wrath: [st.wrath, next.wrath],
      lockoutCleared: Boolean(st.lockout) && !next.lockout,
      consentReset: st.consentUsed === true,
    };
    if (!res.lockoutCleared && !res.consentReset && next.wrath === st.wrath) return { result: { res, wrote: false } };
    const log =
      next.wrath !== st.wrath
        ? logEntry("deed", {
            deed: "night",
            loyalty: [st.loyalty, st.loyalty],
            wrath: res.wrath,
            level: [st.level, st.level],
          })
        : null;
    return {
      patch: { wrath: next.wrath, lockout: next.lockout, consentUsed: false },
      log,
      result: { res, wrote: true },
    };
  });
  if (!out.wrote) return out.res;
  if (out.res.wrath[0] !== out.res.wrath[1]) await rebuildValuesPage(actor);
  await syncActor(actor);
  return out.res;
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
