import { describe, it, expect } from "vitest";
import { flattenForUpdate, deleteSubsystemFlag } from "../src/core/flags.mjs";
import { MODULE_ID } from "../src/core/constants.mjs";

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

/**
 * This used to hand the update payload `foundry.data.operators.ForcedDeletion`
 * itself — the class, not an instance — which serializes away, so Remove
 * attunement left the whole namespace on the actor. Shared with Izir's unattune
 * path. (item 33)
 */
describe("deleteSubsystemFlag", () => {
  const spyActor = () => {
    const calls = { unsetFlag: [], update: [] };
    return {
      calls,
      unsetFlag: async (...args) => calls.unsetFlag.push(args),
      update: async (...args) => calls.update.push(args),
    };
  };

  it("unsets the namespace through the document API", async () => {
    const actor = spyActor();
    await deleteSubsystemFlag(actor, "ansu");
    expect(actor.calls.unsetFlag).toEqual([[MODULE_ID, "ansu"]]);
    expect(actor.calls.update).toEqual([]);
  });

  it("passes no operator value at all (the old payload carried a class)", async () => {
    const actor = spyActor();
    await deleteSubsystemFlag(actor, "izir");
    expect(actor.calls.unsetFlag[0]).toHaveLength(2);
    expect(actor.calls.unsetFlag[0].some((a) => typeof a === "function")).toBe(false);
  });

  it("falls back to the -= payload when the document has no unsetFlag", async () => {
    const calls = [];
    await deleteSubsystemFlag({ update: async (u) => calls.push(u) }, "ansu");
    expect(calls).toEqual([{ [`flags.${MODULE_ID}.-=ansu`]: null }]);
  });

  it("does nothing on junk input instead of throwing", async () => {
    await expect(deleteSubsystemFlag(null, "ansu")).resolves.toBeUndefined();
    await expect(deleteSubsystemFlag({}, "ansu")).resolves.toBeUndefined();
    await expect(deleteSubsystemFlag({ unsetFlag: "not a function" }, "ansu")).resolves.toBeUndefined();
  });
});
