/**
 * The Seizure override — the Ansu takes the body.
 *
 * GM button, any attunement: snapshot the actor's whole subsystem state, then
 * compose Communion at full strength (every boon through attunement 10, no
 * duration, no saves) while the GM plays the character. The same button restores
 * the exact pre-seizure state. The 1-round critical-failure seizure is the same
 * mechanism with an auto-return at the end of the bearer's next turn (then
 * Lingering resumes, per the hard rule).
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "./state.mjs";
import { syncActor } from "./sync.mjs";
import { refreshAnsuPanel } from "./apps/ansu-panel.mjs";

async function whisperGM(actor, key, data = {}) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p class="ansu-card-title"><i class="fa-solid fa-hand-back-fist"></i> ${game.i18n.format(key, data)}</p></div>`,
    whisper: gmIds,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

/** Is a seizure currently running? */
export function isSeized(state) {
  return state.communion?.mode === "seized";
}

/**
 * Take the body. `auto` marks the 1-round crit-fail variant (returns by itself
 * at the end of the bearer's next turn); a manual seizure holds until the GM
 * presses Return. No-op at a terminal or while already seized.
 */
export async function startSeizure(actor, { auto = false } = {}) {
  const st = readAnsu(actor);
  if (st.terminal || isSeized(st)) return;

  const snapshot = {
    level: st.level,
    climb: st.climb,
    terminal: st.terminal,
    communion: st.communion,
    pendingRelease: st.pendingRelease,
  };
  await patchAnsu(actor, {
    communion: { mode: "seized", rounds: null },
    pendingRelease: null,
    seizure: { snapshot, at: Date.now(), auto, roundsLeft: auto ? 1 : null },
  });
  await appendLog(actor, "seizure", { on: true, auto });
  await syncActor(actor);
  await whisperGM(actor, auto ? "SHARDS.Ansu.SeizureAutoStart" : "SHARDS.Ansu.SeizureStart", { name: actor.name });
  refreshAnsuPanel();
}

/**
 * Give the body back. Restores the snapshot exactly (level, climb, communion,
 * pending roll — everything as it was before the press). The auto variant slips
 * to Lingering instead: the wrestle continues.
 */
export async function returnFromSeizure(actor, { toLingering = false } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure?.snapshot) return;

  const snap = st.seizure.snapshot;
  await patchAnsu(actor, {
    level: snap.level,
    climb: snap.climb,
    terminal: snap.terminal,
    communion: toLingering ? { mode: "lingering", rounds: null } : snap.communion,
    pendingRelease: toLingering ? null : snap.pendingRelease,
    seizure: null,
  });
  await appendLog(actor, "seizure", { on: false, toLingering });
  await syncActor(actor);
  await whisperGM(actor, "SHARDS.Ansu.SeizureEnd", { name: actor.name });
  refreshAnsuPanel();
}

/**
 * Combat-sweep hook: an auto (crit-fail) seizure returns at the end of the
 * bearer's next turn. `force` returns any auto seizure immediately (combat
 * deleted mid-hold). Manual seizures never auto-return.
 */
export async function maybeReturnFromSeizure(actor, combat, { force = false } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure?.auto) return;

  if (force) {
    await returnFromSeizure(actor, { toLingering: true });
    return;
  }

  const prevActor = combat?.combatants.get(combat.previous?.combatantId)?.actor ?? null;
  if (!prevActor || prevActor.uuid !== actor.uuid) return; // not their turn-end

  const left = Math.max(0, Number(st.seizure.roundsLeft ?? 1) - 1);
  if (left > 0) {
    await patchAnsu(actor, { seizure: { ...st.seizure, roundsLeft: left } });
    return;
  }
  await returnFromSeizure(actor, { toLingering: true });
}
