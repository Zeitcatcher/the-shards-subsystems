import { describe, it, expect } from "vitest";
import { emptyIzirState, healDefaults, withActorLock, LOG_CAP } from "../src/subsystems/izir/state.mjs";

describe("emptyIzirState", () => {
  it("starts a marked actor at level 0 with nothing suppressed and an empty slide", () => {
    const s = emptyIzirState();
    expect(s.enabled).toBe(true);
    expect(s.level).toBe(0);
    expect(s.slide).toBe(0);
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

  it("preserves stored values and fills missing keys (v1 data gains the slide)", () => {
    const healed = healDefaults({ v: 1, level: 6, terminal: "subjugated", suppressed: [{ id: "izir-wave" }] });
    expect(healed.level).toBe(6);
    expect(healed.terminal).toBe("subjugated");
    expect(healed.suppressed).toEqual([{ id: "izir-wave" }]);
    // untouched/new keys still present
    expect(healed.slide).toBe(0);
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

describe("withActorLock", () => {
  const actor = (uuid) => ({ uuid });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("serializes overlapping mutations on one actor", async () => {
    // The bug this exists for: both callers read the same starting value inside a
    // single server round trip and the second write wins, losing an increment and
    // a history row. (F18)
    let value = 0;
    const bump = async () => {
      const read = value;
      await tick();
      value = read + 1;
    };
    const a = actor("Actor.a1");
    await Promise.all([withActorLock(a, bump), withActorLock(a, bump), withActorLock(a, bump)]);
    expect(value).toBe(3);
  });

  it("does not make two different actors wait on each other", async () => {
    const order = [];
    const slow = async () => {
      await tick();
      await tick();
      order.push("slow");
    };
    const fast = async () => {
      order.push("fast");
    };
    await Promise.all([withActorLock(actor("Actor.a1"), slow), withActorLock(actor("Actor.a2"), fast)]);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("a thrown mutation does not wedge the queue behind it", async () => {
    const a = actor("Actor.a1");
    await expect(
      withActorLock(a, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withActorLock(a, async () => "next")).resolves.toBe("next");
  });

  it("runs unlocked rather than dropping the work when there is no key", async () => {
    await expect(withActorLock(null, async () => "ran")).resolves.toBe("ran");
  });

  it("exports the log cap so every writer can respect it", () => {
    expect(LOG_CAP).toBe(300);
  });
});
