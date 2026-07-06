import { describe, it, expect } from "vitest";
import { flattenForUpdate } from "../src/core/flags.mjs";

describe("flattenForUpdate", () => {
  it("flattens nested plain objects to dot paths", () => {
    const out = flattenForUpdate({ level: 4, art: { applied: "4" } }, "flags.mod.izir");
    expect(out).toEqual({
      "flags.mod.izir.level": 4,
      "flags.mod.izir.art.applied": "4",
    });
  });

  it("treats arrays as leaf values (whole-array replacement)", () => {
    const out = flattenForUpdate({ suppressed: [{ id: "a" }], revealed: ["x", "y"] }, "root");
    expect(out).toEqual({
      "root.suppressed": [{ id: "a" }],
      "root.revealed": ["x", "y"],
    });
  });

  it("passes null and primitives through as leaves", () => {
    const out = flattenForUpdate({ terminal: null, level: 0, journalId: "j1" }, "r");
    expect(out).toEqual({ "r.terminal": null, "r.level": 0, "r.journalId": "j1" });
  });

  it("recurses several levels deep", () => {
    const out = flattenForUpdate({ art: { thresholds: { 4: { portrait: "p" } } } }, "r");
    expect(out).toEqual({ "r.art.thresholds.4.portrait": "p" });
  });
});
