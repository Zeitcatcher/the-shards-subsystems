import { describe, it, expect } from "vitest";
import {
  seizureSnapshot,
  restoredPendings,
  seizureKind,
  seizureLanding,
  takeoverPlan,
  takeoverTurnEnd,
  returnsOnCombatEnd,
} from "../src/subsystems/ansu/logic/seizure.mjs";

/**
 * A seizure freezes the whole subsystem state, so the snapshot's field list IS
 * the contract. `pendingCall` was missing from it: a Call rolled during a manual
 * GM seizure was consumed for nothing, because `invokeCommunion` bails on
 * `mode !== "none"` and `startSeizure` bails on `isSeized`, while the GM was
 * still whispered "the Ansu comes anyway". (item 11)
 */
const state = (over = {}) => ({
  level: 4,
  climb: 3,
  terminal: null,
  communion: { mode: "active", rounds: 3, startAt: null },
  pendingRelease: { id: "rel1", dc: 26 },
  pendingCall: { id: "call1", dc: 28 },
  log: [{ t: 1 }],
  cooldowns: [{ id: "the-ansu-refuses", until: 99 }],
  ...over,
});

describe("seizureSnapshot", () => {
  it("keeps every field the Return has to put back, both open cards included", () => {
    expect(seizureSnapshot(state())).toEqual({
      level: 4,
      climb: 3,
      terminal: null,
      communion: { mode: "active", rounds: 3, startAt: null },
      pendingRelease: { id: "rel1", dc: 26 },
      pendingCall: { id: "call1", dc: 28 },
    });
  });

  it("carries nothing else: the log and the cooldowns are never rolled back", () => {
    expect(Object.keys(seizureSnapshot(state())).sort()).toEqual([
      "climb",
      "communion",
      "level",
      "pendingCall",
      "pendingRelease",
      "terminal",
    ]);
  });

  it("normalises a missing card to null rather than undefined", () => {
    const snap = seizureSnapshot(state({ pendingCall: undefined, pendingRelease: undefined }));
    expect(snap.pendingCall).toBeNull();
    expect(snap.pendingRelease).toBeNull();
  });

  it("survives junk input", () => {
    expect(seizureSnapshot()).toEqual({
      level: undefined,
      climb: undefined,
      terminal: undefined,
      communion: undefined,
      pendingRelease: null,
      pendingCall: null,
    });
  });
});

describe("restoredPendings (0.8 landings)", () => {
  const snapshot = seizureSnapshot(state());

  it("hands both cards back on a snapshot landing (manual, forced), ids and all", () => {
    expect(restoredPendings({ snapshot, landing: "snapshot" })).toEqual({
      pendingRelease: { id: "rel1", dc: 26 },
      pendingCall: { id: "call1", dc: 28 },
    });
  });

  it("drops both when a berserk takeover lands dormant", () => {
    expect(restoredPendings({ snapshot, landing: "dormant" })).toEqual({ pendingRelease: null, pendingCall: null });
  });

  it("drops both when an agreed takeover lands on a fresh release card", () => {
    expect(restoredPendings({ snapshot, landing: "release" })).toEqual({ pendingRelease: null, pendingCall: null });
  });

  it("treats an unknown landing as a snapshot landing, not as a drop", () => {
    expect(restoredPendings({ snapshot, landing: "nonsense" }).pendingCall).toEqual({ id: "call1", dc: 28 });
  });

  it("survives a missing or junk snapshot", () => {
    expect(restoredPendings()).toEqual({ pendingRelease: null, pendingCall: null });
    expect(restoredPendings({ snapshot: null })).toEqual({ pendingRelease: null, pendingCall: null });
    expect(restoredPendings({ snapshot: "nope" })).toEqual({ pendingRelease: null, pendingCall: null });
  });
});

describe("seizureSnapshot with the rounds left (0.8)", () => {
  it("stores a running Communion with the rounds it had left, so it resumes", () => {
    expect(seizureSnapshot(state(), { roundsLeft: 2 }).communion).toEqual({ mode: "active", rounds: 2, startAt: null });
  });
  it("keeps the stamp when no countdown was readable, or nothing ran", () => {
    expect(seizureSnapshot(state(), { roundsLeft: null }).communion.rounds).toBe(3);
    expect(seizureSnapshot(state(), { roundsLeft: 0 }).communion.rounds).toBe(3);
    const dormant = state({ communion: { mode: "none", rounds: null, startAt: null } });
    expect(seizureSnapshot(dormant, { roundsLeft: 4 }).communion.rounds).toBeNull();
  });
});

describe("seizureKind", () => {
  it("reads the stored kind", () => {
    for (const kind of ["manual", "forced", "berserk", "agreed"]) expect(seizureKind({ kind })).toBe(kind);
  });
  it("reads a seizure stored before 0.8 as auto ? forced : manual", () => {
    expect(seizureKind({ auto: true })).toBe("forced");
    expect(seizureKind({ auto: false })).toBe("manual");
    expect(seizureKind({ kind: "nonsense" })).toBe("manual");
  });
  it("is null with no seizure", () => {
    expect(seizureKind(null)).toBeNull();
    expect(seizureKind()).toBeNull();
  });
});

describe("seizureLanding", () => {
  const seized = (seizure) => ({ communion: { mode: "seized" }, seizure });
  it("restores the snapshot for manual and forced takeovers", () => {
    expect(seizureLanding(seized({ kind: "manual" }))).toBe("snapshot");
    expect(seizureLanding(seized({ kind: "forced" }))).toBe("snapshot");
    expect(seizureLanding(seized({ auto: true }))).toBe("snapshot");
  });
  it("lands a berserk takeover dormant and an agreed one on the release", () => {
    expect(seizureLanding(seized({ kind: "berserk" }))).toBe("dormant");
    expect(seizureLanding(seized({ kind: "agreed" }))).toBe("release");
  });
  it("is null when nothing holds the body, and survives junk", () => {
    expect(seizureLanding({ communion: { mode: "active" }, seizure: { kind: "forced" } })).toBeNull();
    expect(seizureLanding({})).toBeNull();
    expect(seizureLanding(null)).toBeNull();
    expect(seizureLanding()).toBeNull();
  });
});

describe("takeoverPlan", () => {
  it("calm returns at the next turn end, angry one later, breaking goes berserk", () => {
    expect(takeoverPlan("calm")).toEqual({ kind: "forced", turnsLeft: 1, deed: "vented-1" });
    expect(takeoverPlan("angry")).toEqual({ kind: "forced", turnsLeft: 2, deed: "vented-2" });
    expect(takeoverPlan("breaking")).toEqual({ kind: "berserk", turnsLeft: null, deed: "berserk-end" });
  });
});

describe("takeoverTurnEnd", () => {
  it("counts a forced takeover down and hands back at zero", () => {
    expect(takeoverTurnEnd({ kind: "forced", turnsLeft: 2 })).toMatchObject({ turnsLeft: 1, due: false });
    expect(takeoverTurnEnd({ kind: "forced", turnsLeft: 1 })).toMatchObject({ turnsLeft: 0, due: true });
  });
  it("lets the turn the takeover began on pass without counting it, once", () => {
    const first = takeoverTurnEnd({ kind: "forced", turnsLeft: 1, skipTurnEnd: true });
    expect(first).toEqual({ turnsLeft: 1, skipTurnEnd: false, due: false, check: false });
    expect(takeoverTurnEnd({ kind: "forced", ...first }).due).toBe(true);
  });
  it("counts an agreed takeover the same way", () => {
    expect(takeoverTurnEnd({ kind: "agreed", turnsLeft: 3 })).toMatchObject({ turnsLeft: 2, due: false });
  });
  it("asks for the Will check at each berserk turn end, never returns by itself", () => {
    expect(takeoverTurnEnd({ kind: "berserk" })).toMatchObject({ due: false, check: true });
    expect(takeoverTurnEnd({ kind: "berserk", skipTurnEnd: true })).toMatchObject({ due: false, check: false });
  });
  it("never moves a manual hold", () => {
    expect(takeoverTurnEnd({ kind: "manual", turnsLeft: 1 })).toMatchObject({ due: false, check: false });
    expect(takeoverTurnEnd()).toMatchObject({ due: false, check: false });
  });
});

describe("returnsOnCombatEnd", () => {
  it("hands back forced and agreed takeovers; berserk and manual wait for the GM", () => {
    expect(returnsOnCombatEnd("forced")).toBe(true);
    expect(returnsOnCombatEnd("agreed")).toBe(true);
    expect(returnsOnCombatEnd("berserk")).toBe(false);
    expect(returnsOnCombatEnd("manual")).toBe(false);
  });
});
