import { describe, it, expect } from "vitest";
import { emptyAnsuState, healDefaults } from "../src/subsystems/ansu/state.mjs";

describe("healDefaults", () => {
  it("returns full defaults for missing/junk raw", () => {
    expect(healDefaults(undefined)).toEqual(emptyAnsuState());
    expect(healDefaults(null)).toEqual(emptyAnsuState());
    expect(healDefaults(42)).toEqual(emptyAnsuState());
  });
  it("keeps raw values and heals missing keys (old data gains communion/seizure/cooldowns)", () => {
    const healed = healDefaults({ level: 4, climb: 3 });
    expect(healed.level).toBe(4);
    expect(healed.climb).toBe(3);
    expect(healed.communion).toEqual({ mode: "none", rounds: null, startAt: null, returnPenalty: 0 });
    expect(healed.seizure).toBeNull();
    expect(healed.cooldowns).toEqual([]);
    expect(healed.art.thresholds[7]).toEqual({ portrait: "", token: "" });
  });
  it("recurses into nested objects without dropping siblings", () => {
    const healed = healDefaults({ communion: { mode: "active" }, art: { applied: "4" } });
    expect(healed.communion).toEqual({ mode: "active", rounds: null, startAt: null, returnPenalty: 0 });
    expect(healed.art.applied).toBe("4");
    expect(healed.art.original).toBeNull();
  });
  it("keeps the seizure return's one-shot clock stamp (merge only walks default keys)", () => {
    const healed = healDefaults({ communion: { mode: "active", rounds: 1, startAt: 126 } });
    expect(healed.communion.startAt).toBe(126);
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

describe("rework 0.8 state healing", () => {
  it("fresh state carries the new defaults", () => {
    const s = emptyAnsuState();
    expect(s.loyalty).toBe(5);
    expect(s.wrath).toBe(0);
    expect(s.lockout).toBeNull();
    expect(s.consentUsed).toBe(false);
    expect(s.communion.returnPenalty).toBe(0);
  });
  it("a 0.7 flag gains loyalty 5, wrath 0, no lockout, no consent; climb is not converted", () => {
    const h = healDefaults({ level: 8, climb: 7, communion: { mode: "active" } });
    expect(h).toMatchObject({ level: 8, climb: 7, loyalty: 5, wrath: 0, lockout: null, consentUsed: false });
    expect(h.communion).toMatchObject({ mode: "active", returnPenalty: 0 });
  });
  it("clamps bad stored values", () => {
    const h = healDefaults({ loyalty: 14, wrath: -2, consentUsed: "yes", communion: { returnPenalty: 5 } });
    expect(h.loyalty).toBe(10);
    expect(h.wrath).toBe(0);
    expect(h.consentUsed).toBe(false);
    expect(h.communion.returnPenalty).toBe(0);
  });
  it("keeps a valid lockout and drops a malformed one", () => {
    expect(healDefaults({ lockout: { until: 500, untilRest: false } }).lockout).toEqual({ until: 500, untilRest: false });
    expect(healDefaults({ lockout: { until: null, untilRest: true } }).lockout).toEqual({ until: null, untilRest: true });
    expect(healDefaults({ lockout: { until: null, untilRest: false } }).lockout).toBeNull();
    expect(healDefaults({ lockout: "soon" }).lockout).toBeNull();
    expect(healDefaults({ communion: { returnPenalty: 2 } }).communion.returnPenalty).toBe(2);
  });
});
