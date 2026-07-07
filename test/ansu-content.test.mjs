import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent, indexContent } from "../src/subsystems/ansu/content.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(ROOT, "data/ansu/content.json"), "utf8"));

describe("data/ansu/content.json", () => {
  it("passes the runtime schema validation", () => {
    expect(validateContent(raw)).toEqual([]);
  });
  it("indexes with unique ids and family groups", () => {
    const idx = indexContent(raw);
    expect(idx.byId.size).toBe(raw.entries.length);
    expect(idx.byFamily.get("ancestral-vigor")).toHaveLength(2); // rank 1 + Union upgrade
  });
  it("covers the approved ladder: every level 1..9 has at least one entry, 10 is gated", () => {
    for (let lvl = 1; lvl <= 9; lvl += 1) {
      expect(raw.entries.some((e) => e.level === lvl && !e.gate)).toBe(true);
    }
    const tens = raw.entries.filter((e) => e.level === 10);
    expect(tens.length).toBeGreaterThan(0);
    expect(tens.every((e) => e.gate === "subjugated")).toBe(true);
  });
  it("ships the rev-3 ladder: 21 entries, five GM-approved new actives", () => {
    expect(raw.entries).toHaveLength(21);
    for (const id of ["makers-wrath", "fair-battle", "salbarine-parry", "hurl-the-blade", "the-ansu-refuses"]) {
      expect(raw.entries.some((e) => e.id === id && e.form === "action")).toBe(true);
    }
  });
  it("keeps the Inheritance line thin: always-on entries are bonus feats", () => {
    const always = raw.entries.filter((e) => e.always);
    expect(always.map((e) => e.id).sort()).toEqual(["engineers-eye", "tongue-of-the-makers"]);
    expect(always.every((e) => e.form === "feat")).toBe(true);
  });
  it("only Invoke stays on the sheet while dormant", () => {
    const doors = raw.entries.filter((e) => e.actionData?.alwaysAvailable);
    expect(doors.map((e) => e.id)).toEqual(["invoke-the-ansu"]);
  });
  it("per-communion actives carry the frequency the module resets", () => {
    const per = raw.entries.filter((e) => e.actionData?.perCommunion);
    expect(per.map((e) => e.id)).toEqual(["roar-of-the-old-blood"]);
    expect(per[0].actionData.frequency).toEqual({ max: 1, per: "day" });
  });
  it("The Ansu Refuses runs the module-owned 10-minute cooldown", () => {
    const refuses = raw.entries.find((e) => e.id === "the-ansu-refuses");
    expect(refuses.actionData.cooldownMinutes).toBe(10);
    expect(refuses.actionData.frequency).toEqual({ max: 1, per: "day" });
    expect(refuses.actionData.actionType).toBe("reaction");
  });
  it("Stature has no size change — reach rides a Note rule", () => {
    const stature = raw.entries.find((e) => e.id === "ansus-stature");
    expect(stature.rules.some((r) => r.key === "CreatureSize")).toBe(false);
    expect(stature.rules.some((r) => r.key === "Note")).toBe(true);
  });
});
