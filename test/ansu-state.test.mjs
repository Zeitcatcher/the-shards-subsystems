import { describe, it, expect } from "vitest";
import { emptyAnsuState, healDefaults } from "../src/subsystems/ansu/state.mjs";

describe("healDefaults", () => {
  it("returns full defaults for missing/junk raw", () => {
    expect(healDefaults(undefined)).toEqual(emptyAnsuState());
    expect(healDefaults(null)).toEqual(emptyAnsuState());
    expect(healDefaults(42)).toEqual(emptyAnsuState());
  });
  it("keeps raw values and heals missing keys (old data gains communion/seizure)", () => {
    const healed = healDefaults({ level: 4, climb: 3 });
    expect(healed.level).toBe(4);
    expect(healed.climb).toBe(3);
    expect(healed.communion).toEqual({ mode: "none", rounds: null });
    expect(healed.seizure).toBeNull();
    expect(healed.art.thresholds[7]).toEqual({ portrait: "", token: "" });
  });
  it("recurses into nested objects without dropping siblings", () => {
    const healed = healDefaults({ communion: { mode: "active" }, art: { applied: "4" } });
    expect(healed.communion).toEqual({ mode: "active", rounds: null });
    expect(healed.art.applied).toBe("4");
    expect(healed.art.original).toBeNull();
  });
  it("takes arrays and nullable objects wholesale from raw", () => {
    const log = [{ t: 1, type: "mark", data: {} }];
    const pending = { id: "x", dc: 22, reason: "", createdAt: 1 };
    const healed = healDefaults({ log, pendingRelease: pending, suppressed: [{ id: "vigor" }] });
    expect(healed.log).toEqual(log);
    expect(healed.pendingRelease).toEqual(pending);
    expect(healed.suppressed).toEqual([{ id: "vigor" }]);
  });
});
