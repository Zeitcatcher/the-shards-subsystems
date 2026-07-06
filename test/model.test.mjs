import { describe, it, expect } from "vitest";
import { tierForLevel, clampLevel, dcFor, TIERS, MAX_LEVEL } from "../src/subsystems/izir/logic/model.mjs";

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
    expect(clampLevel(undefined)).toBe(0);
    expect(clampLevel(null)).toBe(0);
  });
});

describe("tierForLevel", () => {
  it("maps each level to the right tier band", () => {
    expect(tierForLevel(0).id).toBe("marked");
    expect(tierForLevel(1).id).toBe("whisper");
    expect(tierForLevel(3).id).toBe("whisper");
    expect(tierForLevel(4).id).toBe("grip");
    expect(tierForLevel(6).id).toBe("grip");
    expect(tierForLevel(7).id).toBe("call");
    expect(tierForLevel(9).id).toBe("call");
    expect(tierForLevel(10).id).toBe("nineveh");
  });
  it("covers every level 0..10 with exactly one tier", () => {
    for (let l = 0; l <= MAX_LEVEL; l += 1) {
      const hits = TIERS.filter((t) => l >= t.min && l <= t.max);
      expect(hits).toHaveLength(1);
    }
  });
});

describe("dcFor", () => {
  it("uses 14 + 2×level by default", () => {
    expect(dcFor(0)).toBe(14);
    expect(dcFor(1)).toBe(16);
    expect(dcFor(5)).toBe(24);
    expect(dcFor(10)).toBe(34);
  });
  it("honours custom base and step", () => {
    expect(dcFor(3, 10, 3)).toBe(19);
    expect(dcFor(0, 20, 5)).toBe(20);
  });
  it("never returns below 1 even with a broken base", () => {
    expect(dcFor(0, -100, 0)).toBe(1);
  });
});
