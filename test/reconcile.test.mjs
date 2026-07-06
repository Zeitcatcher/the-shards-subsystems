import { describe, it, expect } from "vitest";
import { computeDesired, diffItems, hashEntry } from "../src/subsystems/izir/logic/reconcile.mjs";
import { emptyIzirState } from "../src/subsystems/izir/state.mjs";

const CONTENT = {
  entries: [
    { id: "voidsight", family: "voidsight", rank: 1, level: 1, kind: "boon", form: "effect", name: "Voidsight", rules: [] },
    { id: "mark", family: "mark", rank: 1, level: 2, kind: "bane", form: "effect", name: "Mark", rules: [] },
    { id: "wave1", family: "wave", rank: 1, level: 3, kind: "boon", form: "action", name: "Wave I", actionData: {} },
    { id: "wave2", family: "wave", rank: 2, level: 5, kind: "boon", form: "action", name: "Wave II", actionData: {} },
    { id: "sovereign", family: "sovereign", rank: 1, level: 10, kind: "boon", form: "effect", name: "Sovereign", gate: "subjugated", rules: [] },
  ],
};

const at = (over) => ({ ...emptyIzirState(), ...over });
const ids = (state, opts) => computeDesired(state, CONTENT, opts).map((d) => d.entryId);

describe("computeDesired — level gating", () => {
  it("level 0 produces nothing (marked but dormant)", () => {
    expect(ids(at({ level: 0 }))).toEqual([]);
  });
  it("prepends the marker once at least one power exists", () => {
    expect(ids(at({ level: 1 }))).toEqual(["izir-marker", "voidsight"]);
  });
  it("accumulates entries by level, ordered", () => {
    expect(ids(at({ level: 2 }))).toEqual(["izir-marker", "voidsight", "mark"]);
  });
});

describe("computeDesired — family replacement", () => {
  it("keeps only the highest unlocked rank of a family", () => {
    expect(ids(at({ level: 3 }))).toContain("wave1");
    const five = ids(at({ level: 5 }));
    expect(five).toContain("wave2");
    expect(five).not.toContain("wave1");
  });
});

describe("computeDesired — suppression", () => {
  it("drops a suppressed family (bane or boon)", () => {
    expect(ids(at({ level: 2, suppressed: [{ id: "mark", reason: "earned" }] }))).not.toContain("mark");
    expect(ids(at({ level: 2, suppressed: [{ id: "voidsight" }] }))).not.toContain("voidsight");
  });
});

describe("computeDesired — visibility", () => {
  it("boons are always identified; banes hidden by default", () => {
    const d = computeDesired(at({ level: 2 }), CONTENT);
    expect(d.find((x) => x.entryId === "voidsight").identified).toBe(true);
    expect(d.find((x) => x.entryId === "mark").identified).toBe(false);
  });
  it("revealed banes become identified", () => {
    const d = computeDesired(at({ level: 2, revealed: ["mark"] }), CONTENT);
    expect(d.find((x) => x.entryId === "mark").identified).toBe(true);
  });
  it("transparency mode identifies every bane", () => {
    const d = computeDesired(at({ level: 2 }), CONTENT, { transparency: true });
    expect(d.find((x) => x.entryId === "mark").identified).toBe(true);
  });
});

describe("computeDesired — terminal fork", () => {
  it("nineveh strips everything to the terminal marker", () => {
    const d = computeDesired(at({ level: 10, terminal: "nineveh" }), CONTENT);
    expect(d.map((x) => x.entryId)).toEqual(["izir-marker"]);
    expect(d[0].marker.terminal).toBe("nineveh");
  });
  it("gated capstone appears only under subjugation", () => {
    expect(ids(at({ level: 10, terminal: null }))).not.toContain("sovereign");
    expect(ids(at({ level: 10, terminal: "subjugated" }))).toContain("sovereign");
  });
  it("disabled actor desires nothing", () => {
    expect(ids(at({ level: 5, enabled: false }))).toEqual([]);
  });
});

describe("diffItems", () => {
  const desired = [
    { entryId: "izir-marker", hash: "m1", identified: true },
    { entryId: "voidsight", hash: "h1", identified: true },
  ];

  it("creates everything against an empty actor", () => {
    const { toCreate, toDelete, toUpdate } = diffItems(desired, []);
    expect(toCreate.map((d) => d.entryId)).toEqual(["izir-marker", "voidsight"]);
    expect(toDelete).toEqual([]);
    expect(toUpdate).toEqual([]);
  });

  it("is a no-op when tags match", () => {
    const tagged = [
      { itemId: "i1", entryId: "izir-marker", contentHash: "m1", identified: true },
      { itemId: "i2", entryId: "voidsight", contentHash: "h1", identified: true },
    ];
    const { toCreate, toDelete, toUpdate } = diffItems(desired, tagged);
    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
    expect(toUpdate).toEqual([]);
  });

  it("deletes orphaned tagged items", () => {
    const tagged = [
      { itemId: "i1", entryId: "izir-marker", contentHash: "m1", identified: true },
      { itemId: "i2", entryId: "voidsight", contentHash: "h1", identified: true },
      { itemId: "i9", entryId: "old-thing", contentHash: "z", identified: true },
    ];
    const { toDelete } = diffItems(desired, tagged);
    expect(toDelete.map((t) => t.itemId)).toEqual(["i9"]);
  });

  it("rebuilds (delete+create) when the content hash changed", () => {
    const tagged = [
      { itemId: "i1", entryId: "izir-marker", contentHash: "m1", identified: true },
      { itemId: "i2", entryId: "voidsight", contentHash: "STALE", identified: true },
    ];
    const { toCreate, toDelete } = diffItems(desired, tagged);
    expect(toDelete.map((t) => t.itemId)).toEqual(["i2"]);
    expect(toCreate.map((d) => d.entryId)).toEqual(["voidsight"]);
  });

  it("cheaply updates when only the reveal flag differs", () => {
    const halfHidden = [
      { entryId: "izir-marker", hash: "m1", identified: true },
      { entryId: "voidsight", hash: "h1", identified: false },
    ];
    const tagged = [
      { itemId: "i1", entryId: "izir-marker", contentHash: "m1", identified: true },
      { itemId: "i2", entryId: "voidsight", contentHash: "h1", identified: true },
    ];
    const { toCreate, toDelete, toUpdate } = diffItems(halfHidden, tagged);
    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].tagged.itemId).toBe("i2");
    expect(toUpdate[0].desired.identified).toBe(false);
  });
});

describe("hashEntry", () => {
  it("is stable and reacts to content changes", () => {
    const a = { name: "X", form: "effect", kind: "boon", rules: [{ key: "FlatModifier", value: 1 }] };
    const b = { name: "X", form: "effect", kind: "boon", rules: [{ key: "FlatModifier", value: 1 }] };
    const c = { name: "X", form: "effect", kind: "boon", rules: [{ key: "FlatModifier", value: 2 }] };
    expect(hashEntry(a)).toBe(hashEntry(b));
    expect(hashEntry(a)).not.toBe(hashEntry(c));
  });
});
