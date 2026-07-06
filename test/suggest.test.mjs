import { describe, it, expect } from "vitest";
import { computeStreak, suggestChips } from "../src/subsystems/izir/logic/suggest.mjs";

const t = (outcome) => ({ type: "temptation", data: { outcome } });
const keys = (log, opts) => suggestChips(log, opts).map((c) => c.key);

describe("computeStreak", () => {
  it("counts trailing successes, criticals double", () => {
    expect(computeStreak([t("success"), t("success")])).toBe(2);
    expect(computeStreak([t("criticalSuccess"), t("success")])).toBe(3);
  });
  it("resets on the most recent failure", () => {
    expect(computeStreak([t("success"), t("failure"), t("success")])).toBe(1);
    expect(computeStreak([t("criticalFailure")])).toBe(0);
  });
});

describe("suggestChips", () => {
  it("returns nothing without temptations or when disabled", () => {
    expect(suggestChips([])).toEqual([]);
    expect(suggestChips([t("success")], { enabled: false })).toEqual([]);
    expect(suggestChips([{ type: "level", data: {} }])).toEqual([]);
  });

  it("offers suppression once the success streak is met", () => {
    expect(keys([t("success"), t("success"), t("success")], { streak: 3 })).toContain("suppress");
    expect(keys([t("success"), t("success")], { streak: 3 })).not.toContain("suppress");
    // a crit counts double, so two entries can satisfy a streak of 3
    expect(keys([t("criticalSuccess"), t("success")], { streak: 3 })).toContain("suppress");
  });

  it("offers escalation chips on a critical failure", () => {
    const k = keys([t("criticalFailure")], { streak: 3 });
    expect(k).toEqual(expect.arrayContaining(["deepen", "unsuppress", "surge"]));
  });

  it("offers a gentle reminder on a plain failure", () => {
    expect(keys([t("failure")], { streak: 3 })).toEqual(["remind"]);
  });

  it("ignores malformed entries", () => {
    expect(suggestChips([{ type: "temptation", data: { outcome: "bogus" } }])).toEqual([]);
  });
});
