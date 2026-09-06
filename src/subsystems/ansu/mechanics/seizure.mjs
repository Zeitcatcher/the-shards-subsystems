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

import { MODULE_ID } from "../../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "../state.mjs";
import { durationRounds } from "../logic/model.mjs";
import { seizureReturnDue } from "../logic/timing.mjs";
import { syncActor } from "../sync.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

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
 * Take the body. `auto` marks the 1-round variant (returns by itself at the end
 * of the bearer's next turn); a manual seizure holds until the GM presses
 * Return. `thenMode` names where an auto seizure lands afterwards: "lingering"
 * (release crit-fail — the wrestle continues) or "active" (Call crit-fail — the
 * Ansu came anyway; Communion then runs under the player with a fresh duration).
 * No-op at a terminal or while already seized.
 */
export async function startSeizure(actor, { auto = false, thenMode = "lingering" } = {}) {
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
    // startRound anchors the "1 round" auto-return: a seizure that begins on the
    // bearer's own turn (Invoke → Call → crit fail) must survive that turn's end
    // and return at the end of their NEXT turn, not collapse to zero actions. (B8)
    seizure: { snapshot, at: Date.now(), auto, thenMode, startRound: game.combat?.round ?? null },
  });
  await appendLog(actor, "seizure", { on: true, auto });
  await syncActor(actor);
  await whisperGM(actor, auto ? "SHARDS.Ansu.SeizureAutoStart" : "SHARDS.Ansu.SeizureStart", { name: actor.name });
  refreshAnsuPanel();
}

/**
 * Give the body back. Default restores the snapshot exactly (level, climb,
 * communion, pending roll — everything as before the press). `toMode` overrides
 * the landing state for the auto variants: "lingering" keeps the wrestle going,
 * "active" starts a fresh Communion at the bearer's own tier duration.
 */
export async function returnFromSeizure(actor, { toMode = null } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure?.snapshot) return;

  const snap = st.seizure.snapshot;
  let communion = snap.communion;
  let pendingRelease = snap.pendingRelease;
  if (toMode === "lingering") {
    communion = { mode: "lingering", rounds: null };
    pendingRelease = null;
  } else if (toMode === "active") {
    communion = { mode: "active", rounds: durationRounds(snap.level) };
    pendingRelease = null;
  }
  await patchAnsu(actor, {
    level: snap.level,
    climb: snap.climb,
    terminal: snap.terminal,
    communion,
    pendingRelease,
    seizure: null,
  });
  await appendLog(actor, "seizure", { on: false, toMode });
  await syncActor(actor);
  await whisperGM(actor, "SHARDS.Ansu.SeizureEnd", { name: actor.name });
  refreshAnsuPanel();
}

/**
 * Turn-end hook: an auto seizure returns at the end of the bearer's next turn,
 * landing in its `thenMode`. `force` returns any auto seizure immediately
 * (combat deleted mid-hold). Manual seizures never auto-return.
 *
 * The caller establishes whose turn ended — pf2e's own end-of-turn signal names
 * the combatant — so there is no combat.previous guessing here. The round check
 * still holds the seizure through the turn it began on. (B8, 0.6.5)
 */
export async function maybeReturnFromSeizure(actor, combat, { force = false } = {}) {
  const st = readAnsu(actor);
  const due = seizureReturnDue({
    seized: isSeized(st),
    auto: st.seizure?.auto === true,
    startRound: st.seizure?.startRound,
    round: combat?.round,
    force,
  });
  if (!due) return;
  await returnFromSeizure(actor, { toMode: st.seizure.thenMode === "active" ? "active" : "lingering" });
}
