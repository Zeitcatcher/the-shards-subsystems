/**
 * The Seizure override — the Ansu takes the body.
 *
 * GM button, any attunement: snapshot the actor's whole subsystem state, then
 * compose Communion at full strength (every boon through attunement 10, no
 * duration, no saves) while the GM plays the character. The same button restores
 * the exact pre-seizure state.
 *
 * The 1-round critical-failure seizure is the same mechanism with an auto-return
 * at the end of the bearer's next turn, and it has TWO landings: a failed Release
 * drops back into Lingering (the wrestle continues), while a failed Call lands in
 * a fresh Communion under the player — the Ansu came anyway. (0.6.6)
 */

import { MODULE_ID } from "../../../core/constants.mjs";
import { readAnsu, patchAnsu, appendLog } from "../state.mjs";
import { durationRounds } from "../logic/model.mjs";
import { seizureReturnDue, freshClockStart } from "../logic/timing.mjs";
import { seizureSnapshot, restoredPendings } from "../logic/seizure.mjs";
import { syncActor, encounterOf } from "../sync.mjs";
import { refreshAnsuPanel } from "../apps/ansu-panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** GM-only card. The actor name is player-editable, so escape at the choke point. */
async function whisperGM(actor, key, data = {}) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: `<div class="ansu-card"><p class="ansu-card-title"><i class="fa-solid fa-hand-back-fist"></i> ${esc(game.i18n.format(key, data))}</p></div>`,
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
 * No-op at a terminal or while already seized. Returns whether the body was
 * actually taken, so a caller never reports a seizure that did not start.
 */
export async function startSeizure(actor, { auto = false, thenMode = "lingering" } = {}) {
  const st = readAnsu(actor);
  if (st.terminal || isSeized(st)) return false;

  await patchAnsu(actor, {
    communion: { mode: "seized", rounds: null, startAt: null },
    // Both open cards go away with the body. A Call rolled during a seizure used
    // to be consumed for nothing: invokeCommunion bails on mode !== "none" and
    // startSeizure bails on isSeized, so the outcome vanished. The snapshot keeps
    // them and Return hands the same ids back, still clickable. (0.6.6)
    pendingRelease: null,
    pendingCall: null,
    // startRound anchors the "1 round" auto-return: a seizure that begins on the
    // bearer's own turn (Invoke → Call → crit fail) must survive that turn's end
    // and return at the end of their NEXT turn, not collapse to zero actions. (B8)
    // The bearer's OWN encounter, not the one on the scene the GM is looking at.
    seizure: {
      snapshot: seizureSnapshot(st),
      at: Date.now(),
      auto,
      thenMode,
      startRound: encounterOf(actor)?.round ?? null,
    },
  });
  await appendLog(actor, "seizure", { on: true, auto });
  await syncActor(actor);
  // Name the landing, not just the fact: an auto seizure from a failed Call ends
  // in Communion under the player, and saying "then Lingering resumes" there
  // contradicted the very card the Call posted one line earlier. (0.6.6)
  const key = auto
    ? thenMode === "active"
      ? "SHARDS.Ansu.SeizureAutoStartActive"
      : "SHARDS.Ansu.SeizureAutoStart"
    : "SHARDS.Ansu.SeizureStart";
  await whisperGM(actor, key, { name: actor.name });
  refreshAnsuPanel();
  return true;
}

/**
 * Give the body back. Default restores the snapshot exactly (level, climb,
 * communion, both pending rolls — everything as before the press). `toMode`
 * overrides the landing state for the auto variants: "lingering" keeps the
 * wrestle going, "active" starts a fresh Communion at the bearer's own tier
 * duration; both drop the snapshot's stale cards.
 *
 * `rolledOver` is only ever passed by the turn-end auto-return, and it decides
 * where that fresh countdown begins. The panel's manual Return leaves it null:
 * handing the body back mid-turn already lands the clock correctly.
 */
export async function returnFromSeizure(actor, { toMode = null, rolledOver = null } = {}) {
  const st = readAnsu(actor);
  if (!isSeized(st) || !st.seizure?.snapshot) return;

  const snap = st.seizure.snapshot;
  // A restored snapshot never carries its old start stamp: that clock is spent.
  let communion = { ...snap.communion, startAt: null };
  const { pendingRelease, pendingCall } = restoredPendings({ snapshot: snap, toMode });
  if (toMode === "lingering") {
    communion = { mode: "lingering", rounds: null, startAt: null };
  } else if (toMode === "active") {
    // pf2e resolves a rounds clock at a turn START, and this fires at a turn end.
    // Stamped as-is, a 1-round Communion (attunement 1–3) would expire at the
    // bearer's very next turn start and buy them nothing — while the ability text
    // promises Communion continues under their control. (0.6.6)
    const startAt =
      rolledOver === null
        ? null
        : freshClockStart({ worldTime: game.time?.worldTime, roundTime: CONFIG.time?.roundTime, rolledOver });
    communion = { mode: "active", rounds: durationRounds(snap.level), startAt };
  }
  await patchAnsu(actor, {
    level: snap.level,
    climb: snap.climb,
    terminal: snap.terminal,
    communion,
    pendingRelease,
    pendingCall,
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
 * the combatant — so there is no combat.previous guessing here. It also passes
 * the round that turn BELONGED to: the tracker has already rolled over when the
 * last combatant finishes, and reading it live cancelled the seizure a turn
 * early. `combat.round` stays as the fallback for the force path. (B8, 0.6.6)
 */
export async function maybeReturnFromSeizure(actor, combat, { force = false, round, rolledOver = null } = {}) {
  const st = readAnsu(actor);
  const due = seizureReturnDue({
    seized: isSeized(st),
    auto: st.seizure?.auto === true,
    startRound: st.seizure?.startRound,
    round: round ?? combat?.round,
    force,
  });
  if (!due) return;
  await returnFromSeizure(actor, {
    toMode: st.seizure.thenMode === "active" ? "active" : "lingering",
    rolledOver,
  });
}
