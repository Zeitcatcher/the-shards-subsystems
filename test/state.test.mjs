import { describe, it, expect } from "vitest";
import { emptyIzirState, healDefaults } from "../src/subsystems/izir/state.mjs";

describe("emptyIzirState", () => {
  it("starts a marked actor at level 0 with nothing suppressed", () => {
    const s = emptyIzirState();
    expect(s.enabled).toBe(true);
    expect(s.level).toBe(0);
    expect(s.terminal).toBeNull();
    expect(s.suppressed).toEqual([]);
    expect(s.revealed).toEqual([]);
    expect(s.log).toEqual([]);
    expect(s.art.thresholds[4]).toEqual({ portrait: "", token: "" });
  });
});

describe("healDefaults", () => {
  it("returns full defaults for undefined/null/garbage", () => {
    expect(healDefaults(undefined).level).toBe(0);
    expect(healDefaults(null).enabled).toBe(true);
    expect(healDefaults(42).suppressed).toEqual([]);
  });

  it("preserves stored values and fills missing keys", () => {
    const healed = healDefaults({ level: 6, terminal: "subjugated", suppressed: [{ id: "izir-wave" }] });
    expect(healed.level).toBe(6);
    expect(healed.terminal).toBe("subjugated");
    expect(healed.suppressed).toEqual([{ id: "izir-wave" }]);
    // untouched keys still present
    expect(healed.revealed).toEqual([]);
    expect(healed.journalId).toBeNull();
    expect(healed.art.applied).toBeNull();
  });

  it("deep-merges nested art without dropping sibling thresholds", () => {
    const healed = healDefaults({ art: { applied: "7", thresholds: { 7: { portrait: "p.webp" } } } });
    expect(healed.art.applied).toBe("7");
    expect(healed.art.thresholds[7].portrait).toBe("p.webp");
    // sibling default threshold survives the merge
    expect(healed.art.thresholds[4]).toEqual({ portrait: "", token: "" });
  });

  it("replaces arrays wholesale rather than merging element-wise", () => {
    const healed = healDefaults({ revealed: ["a", "b", "c"] });
    expect(healed.revealed).toEqual(["a", "b", "c"]);
  });
});
