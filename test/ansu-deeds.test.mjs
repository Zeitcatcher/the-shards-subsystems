import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeeds, indexDeeds } from "../src/subsystems/ansu/logic/deeds.mjs";
import { applyDeed } from "../src/subsystems/ansu/logic/model.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(ROOT, "data/ansu/deeds.json"), "utf8"));

describe("data/ansu/deeds.json", () => {
  it("is valid", () => {
    expect(validateDeeds(raw)).toEqual([]);
  });
  it("has the 19 spec deeds with their numbers", () => {
    const { byId, picker } = indexDeeds(raw);
    expect(byId.size).toBe(19);
    expect(picker).toHaveLength(13);
    expect(byId.get("task")).toMatchObject({ loyalty: 2, wrathSet: 0 });
    expect(byId.get("berserk-end")).toMatchObject({ loyalty: -1, wrathSet: 2, auto: true, picker: false });
    expect(byId.get("argument")).toMatchObject({ picker: true, auto: true });
    expect(byId.get("night")).toMatchObject({ wrath: -1, wrathSkipAtLoyalty0: true });
    expect(byId.get("broke-word")).toMatchObject({ loyalty: -2, wrath: 2 });
  });
  it("shipped labels carry no campaign names", () => {
    for (const d of raw.deeds) expect(d.label).not.toMatch(/Grog|Athena/i);
  });
  it("every deed applies through applyDeed, loyalty and wrath both", () => {
    const clampW = (w) => Math.max(0, Math.min(6, w));
    for (const d of raw.deeds) {
      const r = applyDeed({ level: 3, loyalty: 5, wrath: 3 }, d, { charLevel: 8 });
      expect(r.state.loyalty, d.id).toBe(5 + d.loyalty);
      const wrath = Number.isFinite(d.wrathSet) ? d.wrathSet : clampW(3 + d.wrath);
      expect(r.state.wrath, d.id).toBe(wrath);
    }
  });
  it("wrathSet sets wrath outright: task to 0, berserk-end to 2", () => {
    const { byId } = indexDeeds(raw);
    expect(applyDeed({ level: 3, loyalty: 5, wrath: 5 }, byId.get("task"), { charLevel: 8 }).state.wrath).toBe(0);
    expect(applyDeed({ level: 3, loyalty: 5, wrath: 6 }, byId.get("berserk-end"), { charLevel: 8 }).state.wrath).toBe(2);
    expect(applyDeed({ level: 3, loyalty: 5, wrath: 0 }, byId.get("berserk-end"), { charLevel: 8 }).state.wrath).toBe(2);
  });
  it("night skips its wrath -1 at loyalty 0 only", () => {
    const { byId } = indexDeeds(raw);
    const night = byId.get("night");
    expect(applyDeed({ level: 3, loyalty: 0, wrath: 3 }, night, { charLevel: 8 }).state.wrath).toBe(3);
    expect(applyDeed({ level: 3, loyalty: 1, wrath: 3 }, night, { charLevel: 8 }).state.wrath).toBe(2);
  });
  it("holdLevel keeps the level while the Ansu holds the body", () => {
    const st = { level: 3, loyalty: 9, wrath: 0 };
    const argument = indexDeeds(raw).byId.get("argument");
    expect(applyDeed(st, argument, { charLevel: 8 }).leveled).toBe(true);
    const held = applyDeed(st, argument, { charLevel: 8, holdLevel: true });
    expect(held.leveled).toBe(false);
    expect(held.state).toMatchObject({ level: 3, loyalty: 10, wrath: 0 });
  });
});

describe("validateDeeds rejects bad data", () => {
  const ok = { id: "x", label: "X", loyalty: 0, wrath: 1, picker: true, auto: false };
  const bad = (d) => validateDeeds({ deeds: [d] });
  it("empty or missing", () => {
    expect(validateDeeds({ deeds: [] })).not.toEqual([]);
    expect(validateDeeds(null)).not.toEqual([]);
  });
  it("field problems", () => {
    expect(bad(ok)).toEqual([]);
    expect(bad({ ...ok, id: "Bad Id" })).not.toEqual([]);
    expect(bad({ ...ok, wrathSet: 0 })).not.toEqual([]);
    expect(bad({ ...ok, wrath: undefined })).not.toEqual([]);
    expect(bad({ ...ok, loyalty: 1.5 })).not.toEqual([]);
    expect(bad({ ...ok, picker: false, auto: false })).not.toEqual([]);
    expect(bad({ ...ok, extra: 1 })).not.toEqual([]);
    expect(bad({ ...ok, label: "a — b" })).not.toEqual([]);
  });
  it("duplicate ids", () => {
    expect(validateDeeds({ deeds: [ok, ok] })).not.toEqual([]);
  });
});
