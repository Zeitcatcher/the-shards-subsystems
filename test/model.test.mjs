import { describe, it, expect } from "vitest";
import {
  tierForLevel,
  clampLevel,
  dcFor,
  casterBaselineAttack,
  izirAttack,
  izirDC,
  slideNeeded,
  slideDeltaFor,
  applySlide,
  clampSlideForLevel,
  rerollCorrection,
  TIERS,
  MAX_LEVEL,
} from "../src/subsystems/izir/logic/model.mjs";

describe("clampLevel", () => {
  it("keeps in-range integers", () => {
    for (let l = 0; l <= MAX_LEVEL; l += 1) expect(clampLevel(l)).toBe(l);
  });
  it("clamps out-of-range and coerces junk to 0..10", () => {
    expect(clampLevel(-3)).toBe(0);
    expect(clampLevel(99)).toBe(MAX_LEVEL);
    expect(clampLevel(3.9)).toBe(3);
    expect(clampLevel("5")).toBe(5);
    expect(clampLevel("nonsense")).toBe(0);
  });
});

describe("tierForLevel", () => {
  it("maps each level to the right tier band", () => {
    expect(tierForLevel(0).id).toBe("marked");
    expect(tierForLevel(1).id).toBe("whisper");
    expect(tierForLevel(4).id).toBe("grip");
    expect(tierForLevel(7).id).toBe("call");
    expect(tierForLevel(10).id).toBe("nineveh");
  });
  it("covers every level 0..10 with exactly one tier", () => {
    for (let l = 0; l <= MAX_LEVEL; l += 1) {
      expect(TIERS.filter((t) => l >= t.min && l <= t.max)).toHaveLength(1);
    }
  });
});

describe("caster-anchored casting", () => {
  it("baseline matches a standard caster's progression", () => {
    expect(casterBaselineAttack(1)).toBe(7); // +4 attr, trained 2+1
    expect(casterBaselineAttack(5)).toBe(11);
    expect(casterBaselineAttack(7)).toBe(15); // expert
    expect(casterBaselineAttack(10)).toBe(19); // attr +5
    expect(casterBaselineAttack(15)).toBe(26); // master
    expect(casterBaselineAttack(19)).toBe(33); // legendary, attr +6
  });
  it("immersion 5 equals a true caster; each level shifts ±1", () => {
    expect(izirAttack(5, 5)).toBe(11);
    expect(izirAttack(5, 6)).toBe(12); // stronger from 6 up
    expect(izirAttack(5, 9)).toBe(15);
    expect(izirAttack(5, 1)).toBe(7);
    expect(izirAttack(5, 3)).toBe(9); // Molchun at char 5 math
    // parity holds at any character level
    expect(izirAttack(10, 5)).toBe(casterBaselineAttack(10));
    expect(izirAttack(15, 5)).toBe(casterBaselineAttack(15));
  });
  it("DC = 10 + attack", () => {
    expect(izirDC(5, 5)).toBe(21);
    expect(izirDC(5, 9)).toBe(25);
  });
});

describe("dcFor (temptation)", () => {
  it("starts at 20 and climbs by 3 per level", () => {
    expect(dcFor(1)).toBe(20);
    expect(dcFor(2)).toBe(23);
    expect(dcFor(3)).toBe(26);
    expect(dcFor(5)).toBe(32);
    expect(dcFor(9)).toBe(44);
  });
  it("treats level 0 as level 1 and honours custom dials", () => {
    expect(dcFor(0)).toBe(20);
    expect(dcFor(3, 15, 2)).toBe(19);
  });
  it("never returns below 1", () => {
    expect(dcFor(1, -50, 0)).toBe(1);
  });
});

describe("the slide", () => {
  it("needs 3 × current level to rise; inactive at 0 and 10", () => {
    expect(slideNeeded(1)).toBe(3);
    expect(slideNeeded(2)).toBe(6);
    expect(slideNeeded(5)).toBe(15);
    expect(slideNeeded(9)).toBe(27);
    expect(slideNeeded(0)).toBe(0);
    expect(slideNeeded(10)).toBe(0);
  });
  it("maps outcomes: fail +1, crit fail +2, successes hold", () => {
    expect(slideDeltaFor("failure")).toBe(1);
    expect(slideDeltaFor("criticalFailure")).toBe(2);
    expect(slideDeltaFor("success")).toBe(0);
    expect(slideDeltaFor("criticalSuccess")).toBe(0);
  });
  it("accumulates without leveling until the bar fills", () => {
    expect(applySlide(1, 0, 1)).toEqual({ level: 1, slide: 1, leveled: false, atTenth: false });
    expect(applySlide(1, 1, 1)).toEqual({ level: 1, slide: 2, leveled: false, atTenth: false });
  });
  it("levels up when full and carries the overflow", () => {
    expect(applySlide(1, 2, 1)).toEqual({ level: 2, slide: 0, leveled: true, atTenth: false });
    expect(applySlide(1, 2, 2)).toEqual({ level: 2, slide: 1, leveled: true, atTenth: false });
  });
  it("a big manual set can cross several levels", () => {
    // 10 points at level 1: 3 → lvl 2 (7 left), 6 → lvl 3 (1 left)
    expect(applySlide(1, 0, 0, { set: 10 })).toEqual({ level: 3, slide: 1, leveled: true, atTenth: false });
  });
  it("caps at level 9 and signals the Tenth Step instead of entering 10", () => {
    expect(applySlide(9, 26, 1)).toEqual({ level: 9, slide: 27, leveled: false, atTenth: true });
    expect(applySlide(9, 26, 5)).toEqual({ level: 9, slide: 27, leveled: false, atTenth: true });
  });
  it("floors at 0 and is inert at level 0", () => {
    expect(applySlide(2, 1, -5)).toEqual({ level: 2, slide: 0, leveled: false, atTenth: false });
    expect(applySlide(0, 0, 3)).toEqual({ level: 0, slide: 0, leveled: false, atTenth: false });
  });
});

describe("rerollCorrection", () => {
  it("rewinds to the snapshot and applies the new outcome from there", () => {
    // Failure had moved 1→2; the reroll succeeds, so the track goes back to 1.
    expect(rerollCorrection({ level: 3, slide: 1 }, 1, "success")).toEqual({
      level: 3, slide: 1, leveled: false, atTenth: false, newDelta: 0, oldDelta: 1, changed: true,
    });
  });
  it("deepens when the reroll is worse", () => {
    expect(rerollCorrection({ level: 3, slide: 0 }, 1, "criticalFailure")).toEqual({
      level: 3, slide: 2, leveled: false, atTenth: false, newDelta: 2, oldDelta: 1, changed: true,
    });
  });
  it("reports no change when the degree of success is unmoved", () => {
    expect(rerollCorrection({ level: 2, slide: 3 }, 1, "failure").changed).toBe(false);
  });
  it("levels again from the snapshot rather than from the already-levelled state", () => {
    // Level 3 needs 9. From 8, a critical failure tips into level 4 with 1 carried.
    expect(rerollCorrection({ level: 3, slide: 8 }, 2, "criticalFailure")).toMatchObject({
      level: 4, slide: 1, leveled: true,
    });
  });
  it("survives a missing or malformed snapshot", () => {
    expect(rerollCorrection(null, 1, "failure")).toMatchObject({ level: 0, slide: 0 });
    expect(rerollCorrection({ level: "x", slide: -4 }, 0, "success")).toMatchObject({ level: 0, slide: 0 });
  });
});

describe("clampSlideForLevel", () => {
  it("never parks a level below 9 on a full bar", () => {
    // Immersion 5 at 14/15, stepped down to 4: 12/12 would show the bar full and
    // the Tenth Step ready at immersion 4, and the next single failure re-raised
    // the level. applySlide can never produce that state going up. (F23)
    expect(clampSlideForLevel(14, 4)).toBe(11);
    expect(clampSlideForLevel(2, 4)).toBe(2);
    expect(clampSlideForLevel(11, 4)).toBe(11);
  });
  it("lets level 9 sit on a full bar, because that IS the fork signal", () => {
    expect(clampSlideForLevel(99, 9)).toBe(27);
    expect(clampSlideForLevel(27, 9)).toBe(27);
  });
  it("is zero where there is no slide at all", () => {
    expect(clampSlideForLevel(5, 0)).toBe(0);
    expect(clampSlideForLevel(5, 10)).toBe(0);
  });
  it("floors at zero and survives junk", () => {
    expect(clampSlideForLevel(-4, 3)).toBe(0);
    expect(clampSlideForLevel("x", 3)).toBe(0);
  });
});
