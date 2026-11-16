import { describe, it, expect } from "vitest";
import {
  CONFLICT_OPTION,
  CONFLICT_ID_PREFIX,
  acceptConflictRoll,
  conflictResult,
  conflictRerollStep,
  rollTypeFor,
} from "../src/subsystems/ansu/logic/conflict.mjs";

/** The conflict of will's pure rules (0.8, rework step D, spec section 6). */

describe("acceptConflictRoll", () => {
  const opts = (id) => [CONFLICT_OPTION, `${CONFLICT_ID_PREFIX}${id}`];
  it("accepts our tagged roll while a conflict is open, and says whether the card matches", () => {
    expect(acceptConflictRoll({ options: opts("c1"), pendingId: "c1" })).toEqual({ accept: true, idMatch: true, rolledId: "c1" });
    expect(acceptConflictRoll({ options: opts("old"), pendingId: "c1" })).toMatchObject({ accept: true, idMatch: false });
  });
  it("refuses an untagged roll, or one with no open conflict", () => {
    expect(acceptConflictRoll({ options: ["shards-ansu-release"], pendingId: "c1" }).accept).toBe(false);
    expect(acceptConflictRoll({ options: opts("c1"), pendingId: null }).accept).toBe(false);
    expect(acceptConflictRoll().accept).toBe(false);
  });
});

describe("rollTypeFor", () => {
  it("persuasion is a skill check, the Will stages are saves", () => {
    expect(rollTypeFor("persuade")).toBe("skill-check");
    expect(rollTypeFor("will")).toBe("saving-throw");
    expect(rollTypeFor("berserk")).toBe("saving-throw");
  });
});

describe("conflictResult", () => {
  it("persuasion: a success resolves it with `argument`, a failure hands over to the Will save", () => {
    for (const o of ["success", "criticalSuccess"]) {
      expect(conflictResult({ stage: "persuade", outcome: o })).toMatchObject({ deeds: ["argument"], resolved: true, takeover: null });
    }
    for (const o of ["failure", "criticalFailure"]) {
      expect(conflictResult({ stage: "persuade", outcome: o })).toMatchObject({ deeds: [], resolved: false, next: "will" });
    }
  });
  it("Will: CS holds with `argument`, S holds with `forced-back`", () => {
    expect(conflictResult({ stage: "will", outcome: "criticalSuccess" })).toMatchObject({ deeds: ["argument"], takeover: null });
    expect(conflictResult({ stage: "will", outcome: "success" })).toMatchObject({ deeds: ["forced-back"], takeover: null });
  });
  it("Will F: a takeover by the wrath band", () => {
    expect(conflictResult({ stage: "will", outcome: "failure", wrath: 2 }).takeover).toEqual({ kind: "forced", turnsLeft: 1, deed: "vented-1" });
    expect(conflictResult({ stage: "will", outcome: "failure", wrath: 3 }).takeover).toEqual({ kind: "forced", turnsLeft: 2, deed: "vented-2" });
    expect(conflictResult({ stage: "will", outcome: "failure", wrath: 6 }).takeover).toEqual({ kind: "berserk", turnsLeft: null, deed: "berserk-end" });
    expect(conflictResult({ stage: "will", outcome: "failure", wrath: 0 }).deeds).toEqual([]);
  });
  it("Will CF: the same takeover plus `conflict-cf`", () => {
    const r = conflictResult({ stage: "will", outcome: "criticalFailure", wrath: 5 });
    expect(r.deeds).toEqual(["conflict-cf"]);
    expect(r.takeover.kind).toBe("forced");
    expect(r.takeover.turnsLeft).toBe(2);
  });
  it("berserk check: a win hands the body back, a loss keeps it", () => {
    expect(conflictResult({ stage: "berserk", outcome: "success" })).toMatchObject({ handBack: true, deeds: [] });
    expect(conflictResult({ stage: "berserk", outcome: "failure" })).toMatchObject({ handBack: false, resolved: false });
  });
  it("is null for an unknown stage or outcome", () => {
    expect(conflictResult({ stage: "will", outcome: "nope" })).toBeNull();
    expect(conflictResult({ stage: "nope", outcome: "success" })).toBeNull();
    expect(conflictResult()).toBeNull();
  });
});

describe("conflictRerollStep", () => {
  it("a held save rerolled into a loss starts the takeover; the dropped deed is a hand fix", () => {
    const s = conflictRerollStep({ stage: "will", prevOutcome: "success", outcome: "failure", wrath: 0 });
    expect(s.startTakeover).toEqual({ kind: "forced", turnsLeft: 1, deed: "vented-1" });
    expect(s.undoTakeover).toBe(false);
    expect(s.handFix).toBe(true); // forced-back already landed
  });
  it("a lost save rerolled into a hold undoes the takeover and adds the hold's deed", () => {
    const s = conflictRerollStep({ stage: "will", prevOutcome: "failure", outcome: "criticalSuccess", wrath: 0 });
    expect(s.undoTakeover).toBe(true);
    expect(s.addDeeds).toEqual(["argument"]);
    expect(s.handFix).toBe(false);
  });
  it("F into CF adds conflict-cf and touches no takeover", () => {
    const s = conflictRerollStep({ stage: "will", prevOutcome: "failure", outcome: "criticalFailure", wrath: 0 });
    expect(s).toMatchObject({ addDeeds: ["conflict-cf"], startTakeover: null, undoTakeover: false, handFix: false });
  });
  it("persuasion: a failure turned success drops the Will card; a success turned failure posts it", () => {
    expect(conflictRerollStep({ stage: "persuade", prevOutcome: "failure", outcome: "success" })).toMatchObject({
      cancelWill: true,
      addDeeds: ["argument"],
    });
    expect(conflictRerollStep({ stage: "persuade", prevOutcome: "success", outcome: "failure" })).toMatchObject({
      postWill: true,
      handFix: true,
    });
  });
  it("berserk: a loss turned win hands back; a win turned loss is the GM's to fix", () => {
    expect(conflictRerollStep({ stage: "berserk", prevOutcome: "failure", outcome: "success" }).handBack).toBe(true);
    expect(conflictRerollStep({ stage: "berserk", prevOutcome: "success", outcome: "failure" }).handFix).toBe(true);
  });
  it("is inert for an unchanged or junk outcome", () => {
    const inert = conflictRerollStep({ stage: "will", prevOutcome: "success", outcome: "success" });
    expect(inert).toMatchObject({ addDeeds: [], startTakeover: null, undoTakeover: false, handFix: false });
    expect(conflictRerollStep().addDeeds).toEqual([]);
  });
});
