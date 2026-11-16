import { describe, it, expect } from "vitest";
import {
  clampLevel,
  tierForLevel,
  releaseDCFor,
  callDCFor,
  tempHpFor,
  resistFor,
  parryFor,
  tierDiceFor,
  forkAllowed,
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

describe("releaseDCFor with no penalty (20 + 2 × min(N, 5))", () => {
  it("grows to attunement 5 and freezes at 30", () => {
    expect(releaseDCFor(1)).toBe(22);
    expect(releaseDCFor(2)).toBe(24);
    expect(releaseDCFor(3)).toBe(26);
    expect(releaseDCFor(4)).toBe(28);
    expect(releaseDCFor(5)).toBe(30);
    expect(releaseDCFor(6)).toBe(30);
    expect(releaseDCFor(9)).toBe(30);
  });
  it("treats level 0 as 1 and honours custom dials", () => {
    expect(releaseDCFor(0)).toBe(22);
    expect(releaseDCFor(4, 0, { base: 15, step: 1, cap: 5 })).toBe(19);
    expect(releaseDCFor(9, 0, { base: 15, step: 1, cap: 5 })).toBe(20);
    expect(releaseDCFor(9, 0, { base: 14, step: 2, cap: 9 })).toBe(32); // cap raised: keeps growing
  });
  it("never returns below 1", () => {
    expect(releaseDCFor(1, 0, { base: -50, step: 0, cap: 5 })).toBe(1);
  });
});

describe("callDCFor in the wary band (20 + 2×N, uncapped)", () => {
  it("matches the Release ladder through 5, then keeps climbing", () => {
    expect(callDCFor(1, 5)).toBe(22);
    expect(callDCFor(4, 5)).toBe(28);
    expect(callDCFor(5, 5)).toBe(30);
    expect(callDCFor(6, 5)).toBe(32); // release freezes at 30; the Call does not
    expect(callDCFor(9, 5)).toBe(38);
  });
  it("treats level 0 as 1 and honours custom dials", () => {
    expect(callDCFor(0, 5)).toBe(22);
    expect(callDCFor(4, 5, { base: 16, step: 1 })).toBe(20);
  });
  it("never returns below 1", () => {
    expect(callDCFor(1, 5, { base: -50, step: 0 })).toBe(1);
  });
});

describe("baked numbers (rev 3)", () => {
  it("temp HP = 3 × attunement (minimum level 1)", () => {
    expect(tempHpFor(1)).toBe(3);
    expect(tempHpFor(4)).toBe(12);
    expect(tempHpFor(10)).toBe(30);
    expect(tempHpFor(0)).toBe(3);
  });
  it("Salbarine resistance = ⌈attunement / 2⌉", () => {
    expect(resistFor(5)).toBe(3);
    expect(resistFor(7)).toBe(4);
    expect(resistFor(9)).toBe(5);
    expect(resistFor(10)).toBe(5);
  });
  it("Salbarine Parry = 2 × attunement", () => {
    expect(parryFor(5)).toBe(10);
    expect(parryFor(9)).toBe(18);
  });
  it("Maker's Wrath dice = one per tier", () => {
    expect(tierDiceFor(1)).toBe(1);
    expect(tierDiceFor(3)).toBe(1);
    expect(tierDiceFor(4)).toBe(2);
    expect(tierDiceFor(6)).toBe(2);
    expect(tierDiceFor(7)).toBe(3);
    expect(tierDiceFor(10)).toBe(3);
  });
});

describe("forkAllowed", () => {
  it("opens only on the ninth rung", () => {
    expect(forkAllowed({ terminal: null, level: 9 })).toBe(true);
  });
  it("stays shut at every attunement below it", () => {
    for (const level of [0, 1, 2, 5, 8]) {
      expect(forkAllowed({ terminal: null, level })).toBe(false);
    }
  });
  it("stays shut at a terminal, which already chose", () => {
    expect(forkAllowed({ terminal: "subjugated", level: 10 })).toBe(false);
    expect(forkAllowed({ terminal: "taken", level: 10 })).toBe(false);
    expect(forkAllowed({ terminal: "taken", level: 9 })).toBe(false);
  });
  it("survives junk input by staying shut", () => {
    expect(forkAllowed()).toBe(false);
    expect(forkAllowed({})).toBe(false);
    expect(forkAllowed({ level: "nine" })).toBe(false);
  });
});
