import { describe, it, expect } from "vitest";
import { computeStreak, suggestChips } from "../src/subsystems/ansu/logic/suggest.mjs";

const rel = (outcome) => ({ type: "release", data: { outcome } });

describe("computeStreak", () => {
  it("counts trailing clean releases, crits double, failures reset", () => {
    expect(computeStreak([rel("success"), rel("success")].map((e) => e))).toBe(2);
    expect(computeStreak([rel("failure"), rel("criticalSuccess")])).toBe(2);
    expect(computeStreak([rel("success"), rel("failure")])).toBe(0);
    expect(computeStreak([])).toBe(0);
  });
});

describe("suggestChips", () => {
  it("is silent with no releases or when disabled", () => {
    expect(suggestChips([], {})).toEqual([]);
    expect(suggestChips([rel("failure")], { enabled: false })).toEqual([]);
  });
  it("urges on a failure, marks the seizure on a crit fail", () => {
    expect(suggestChips([rel("failure")]).map((c) => c.key)).toEqual(["urge"]);
    expect(suggestChips([rel("criticalFailure")]).map((c) => c.key)).toEqual(["seized"]);
  });
  it("rewards a streak of clean releases", () => {
    const log = [rel("success"), rel("success"), rel("success")];
    expect(suggestChips(log).map((c) => c.key)).toEqual(["discipline"]);
  });
  it("ignores non-release log entries", () => {
    const log = [{ type: "level", data: {} }, rel("failure"), { type: "climb", data: {} }];
    expect(suggestChips(log).map((c) => c.key)).toEqual(["urge"]);
  });
});
