import { describe, it, expect } from "vitest";
import { pickThresholdForLevel } from "../src/subsystems/ansu/logic/art.mjs";

const slots = (a, b, c) => ({ 4: { portrait: a, token: "" }, 7: { portrait: b, token: "" }, 10: { portrait: c, token: "" } });

describe("pickThresholdForLevel (horn stages)", () => {
  it("picks the highest configured threshold at or below the level", () => {
    expect(pickThresholdForLevel(10, slots("a", "b", "c"))).toBe("10");
    expect(pickThresholdForLevel(8, slots("a", "b", "c"))).toBe("7");
    expect(pickThresholdForLevel(5, slots("a", "b", "c"))).toBe("4");
  });
  it("skips empty slots (only broken-horns and Salbarium art configured)", () => {
    expect(pickThresholdForLevel(8, slots("", "", "salb"))).toBeNull();
    expect(pickThresholdForLevel(10, slots("", "", "salb"))).toBe("10");
  });
  it("returns null below every configured threshold", () => {
    expect(pickThresholdForLevel(3, slots("a", "b", "c"))).toBeNull();
  });
});
