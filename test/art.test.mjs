import { describe, it, expect } from "vitest";
import { pickThresholdForLevel } from "../src/subsystems/izir/logic/art.mjs";

const thresholds = {
  4: { portrait: "p4.webp", token: "" },
  7: { portrait: "", token: "t7.webp" },
  10: { portrait: "", token: "" },
};

describe("pickThresholdForLevel", () => {
  it("returns null below the first configured threshold", () => {
    expect(pickThresholdForLevel(0, thresholds)).toBeNull();
    expect(pickThresholdForLevel(3, thresholds)).toBeNull();
  });
  it("picks the highest configured threshold at or below the level", () => {
    expect(pickThresholdForLevel(4, thresholds)).toBe("4");
    expect(pickThresholdForLevel(6, thresholds)).toBe("4");
    expect(pickThresholdForLevel(7, thresholds)).toBe("7");
    expect(pickThresholdForLevel(9, thresholds)).toBe("7");
  });
  it("skips thresholds with no art configured", () => {
    // 10 has empty slots, so level 10 falls back to 7
    expect(pickThresholdForLevel(10, thresholds)).toBe("7");
  });
  it("returns null when nothing is configured", () => {
    expect(pickThresholdForLevel(10, {})).toBeNull();
    expect(pickThresholdForLevel(10, undefined)).toBeNull();
  });
});
