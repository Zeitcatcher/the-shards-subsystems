import { describe, it, expect } from "vitest";
import { seizureSnapshot, restoredPendings, seizeReturnsTo } from "../src/subsystems/ansu/logic/seizure.mjs";

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

describe("restoredPendings", () => {
  const snapshot = seizureSnapshot(state());

  it("hands both cards back on a plain Return, ids and all", () => {
    expect(restoredPendings({ snapshot, toMode: null })).toEqual({
      pendingRelease: { id: "rel1", dc: 26 },
      pendingCall: { id: "call1", dc: 28 },
    });
  });

  it("drops both when the auto-return lands in a fresh Communion", () => {
    expect(restoredPendings({ snapshot, toMode: "active" })).toEqual({
      pendingRelease: null,
      pendingCall: null,
    });
  });

  it("drops both when the auto-return lands in Lingering, which owes a new save", () => {
    expect(restoredPendings({ snapshot, toMode: "lingering" })).toEqual({
      pendingRelease: null,
      pendingCall: null,
    });
  });

  it("treats an unknown landing as a plain Return, not as a drop", () => {
    expect(restoredPendings({ snapshot, toMode: "seized" }).pendingCall).toEqual({ id: "call1", dc: 28 });
  });

  it("survives a missing or junk snapshot", () => {
    expect(restoredPendings()).toEqual({ pendingRelease: null, pendingCall: null });
    expect(restoredPendings({ snapshot: null, toMode: null })).toEqual({ pendingRelease: null, pendingCall: null });
    expect(restoredPendings({ snapshot: "nope", toMode: null })).toEqual({ pendingRelease: null, pendingCall: null });
  });
});

/**
 * The Return button promised "the exact pre-seizure state" for every seizure,
 * while an auto one deliberately lands in its thenMode and throws the snapshot's
 * Communion away. The handler and the tooltip now read the same answer. (item 30)
 */
describe("seizeReturnsTo", () => {
  const seized = (seizure) => ({ communion: { mode: "seized" }, seizure });

  it("is null for a manual GM seizure: the snapshot comes back whole", () => {
    expect(seizeReturnsTo(seized({ auto: false, thenMode: "lingering" }))).toBeNull();
  });

  it("names the fresh Communion a failed Call lands in", () => {
    expect(seizeReturnsTo(seized({ auto: true, thenMode: "active" }))).toBe("active");
  });

  it("names Lingering for a failed Release", () => {
    expect(seizeReturnsTo(seized({ auto: true, thenMode: "lingering" }))).toBe("lingering");
  });

  it("treats an unknown or missing thenMode on an auto seizure as Lingering, matching returnFromSeizure", () => {
    expect(seizeReturnsTo(seized({ auto: true }))).toBe("lingering");
    expect(seizeReturnsTo(seized({ auto: true, thenMode: "nonsense" }))).toBe("lingering");
  });

  it("is null when nothing holds the body, and survives junk", () => {
    expect(seizeReturnsTo({ seizure: null })).toBeNull();
    expect(seizeReturnsTo({})).toBeNull();
    expect(seizeReturnsTo(null)).toBeNull();
    expect(seizeReturnsTo()).toBeNull();
    expect(seizeReturnsTo({ seizure: "nope" })).toBeNull();
  });
});
