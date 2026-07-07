import { describe, it, expect } from "vitest";
import {
  clampLevel,
  tierForLevel,
  releaseDC,
  durationRounds,
  tempHpFor,
  resistFor,
  climbNeeded,
  climbDeltaFor,
  applyClimb,
  TIERS,
  MAX_LEVEL,
} from "../src/subsystems/ansu/logic/model.mjs";

describe("clampLevel", () => {
  it("keeps in-range integers and coerces junk", () => {
    for (let l = 0; l <= MAX_LEVEL; l += 1) expect(clampLevel(l)).toBe(l);
    expect(clampLevel(-3)).toBe(0);
    expect(clampLevel(99)).toBe(MAX_LEVEL);
    expect(clampLevel("7")).toBe(7);
    expect(clampLevel("junk")).toBe(0);
  });
});

describe("tierForLevel", () => {
  it("maps each level to the right tier band", () => {
    expect(tierForLevel(0).id).toBe("attuned");
    expect(tierForLevel(1).id).toBe("trial");
    expect(tierForLevel(3).id).toBe("trial");
    expect(tierForLevel(4).id).toBe("discipline");
    expect(tierForLevel(7).id).toBe("union");
    expect(tierForLevel(10).id).toBe("mastery");
  });
  it("covers every level 0..10 with exactly one tier", () => {
    for (let l = 0; l <= MAX_LEVEL; l += 1) {
      expect(TIERS.filter((t) => l >= t.min && l <= t.max)).toHaveLength(1);
    }
  });
});

describe("releaseDC (GM formula B: 14 + 2 × min(N, 5))", () => {
  it("grows to attunement 5 and freezes after", () => {
    expect(releaseDC(1)).toBe(16);
    expect(releaseDC(2)).toBe(18);
    expect(releaseDC(3)).toBe(20);
    expect(releaseDC(4)).toBe(22);
    expect(releaseDC(5)).toBe(24);
    expect(releaseDC(6)).toBe(24);
    expect(releaseDC(9)).toBe(24);
  });
  it("treats level 0 as 1 and honours custom dials", () => {
    expect(releaseDC(0)).toBe(16);
    expect(releaseDC(4, 15, 1, 5)).toBe(19);
    expect(releaseDC(9, 15, 1, 5)).toBe(20);
    expect(releaseDC(9, 14, 2, 9)).toBe(32); // cap raised: keeps growing
  });
  it("never returns below 1", () => {
    expect(releaseDC(1, -50, 0, 5)).toBe(1);
  });
});

describe("communion duration by tier", () => {
  it("1 round / 3 rounds / 1 minute / permanent", () => {
    expect(durationRounds(0)).toBe(0);
    expect(durationRounds(1)).toBe(1);
    expect(durationRounds(3)).toBe(1);
    expect(durationRounds(4)).toBe(3);
    expect(durationRounds(6)).toBe(3);
    expect(durationRounds(7)).toBe(10);
    expect(durationRounds(9)).toBe(10);
    expect(durationRounds(10)).toBeNull();
  });
});

describe("baked numbers", () => {
  it("temp HP = 2 × attunement (minimum level 1)", () => {
    expect(tempHpFor(1)).toBe(2);
    expect(tempHpFor(4)).toBe(8);
    expect(tempHpFor(10)).toBe(20);
    expect(tempHpFor(0)).toBe(2);
  });
  it("Salbarine resistance = ⌈attunement / 3⌉", () => {
    expect(resistFor(5)).toBe(2);
    expect(resistFor(7)).toBe(3);
    expect(resistFor(9)).toBe(3);
    expect(resistFor(10)).toBe(4);
  });
});

describe("the Climb", () => {
  it("needs 2 + level to rise; inactive at 0 and 10", () => {
    expect(climbNeeded(1)).toBe(3);
    expect(climbNeeded(4)).toBe(6);
    expect(climbNeeded(9)).toBe(11);
    expect(climbNeeded(0)).toBe(0);
    expect(climbNeeded(10)).toBe(0);
  });
  it("honours custom dials", () => {
    expect(climbNeeded(4, 3, 2)).toBe(11);
  });
  it("maps outcomes: clean +1, crit +2, failures hold", () => {
    expect(climbDeltaFor("success")).toBe(1);
    expect(climbDeltaFor("criticalSuccess")).toBe(2);
    expect(climbDeltaFor("failure")).toBe(0);
    expect(climbDeltaFor("criticalFailure")).toBe(0);
  });
  it("accumulates without leveling until the bar fills", () => {
    expect(applyClimb(1, 0, 1)).toEqual({ level: 1, climb: 1, leveled: false, atTenth: false });
    expect(applyClimb(1, 1, 1)).toEqual({ level: 1, climb: 2, leveled: false, atTenth: false });
  });
  it("levels up when full and carries the overflow", () => {
    expect(applyClimb(1, 2, 1)).toEqual({ level: 2, climb: 0, leveled: true, atTenth: false });
    expect(applyClimb(1, 2, 2)).toEqual({ level: 2, climb: 1, leveled: true, atTenth: false });
  });
  it("a big manual set can cross several levels", () => {
    // 8 points at level 1: 3 → lvl 2 (5 left), 4 → lvl 3 (1 left)
    expect(applyClimb(1, 0, 0, { set: 8 })).toEqual({ level: 3, climb: 1, leveled: true, atTenth: false });
  });
  it("caps at level 9 and signals the Tenth Step instead of entering 10", () => {
    expect(applyClimb(9, 10, 1)).toEqual({ level: 9, climb: 11, leveled: false, atTenth: true });
    expect(applyClimb(9, 10, 5)).toEqual({ level: 9, climb: 11, leveled: false, atTenth: true });
  });
  it("floors at 0 and is inert at level 0", () => {
    expect(applyClimb(2, 1, -5)).toEqual({ level: 2, climb: 0, leveled: false, atTenth: false });
    expect(applyClimb(0, 0, 3)).toEqual({ level: 0, climb: 0, leveled: false, atTenth: false });
  });
  it("respects custom dials during carry", () => {
    // base 1, step 0 → every level needs 1 point: 3 points from level 1 → level 4
    expect(applyClimb(1, 0, 3, { base: 1, step: 0 })).toEqual({ level: 4, climb: 0, leveled: true, atTenth: false });
  });
});
