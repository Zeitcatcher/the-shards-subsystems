import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { indexContent, validateContent } from "../src/subsystems/izir/content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(here, "../data/izir/content.json"), "utf8"));

describe("data/izir/content.json", () => {
  it("passes validation with no problems", () => {
    expect(validateContent(raw)).toEqual([]);
  });

  it("indexes by id and family", () => {
    const c = indexContent(raw);
    expect(c.entries.length).toBeGreaterThan(0);
    expect(c.byId.get("voidsight")).toBeTruthy();
    // The replacement family carries two ranks.
    expect(c.byFamily.get("izir-wave").length).toBe(2);
  });

  it("every auraEffectId resolves to a shipped packEffect", () => {
    const c = indexContent(raw);
    const packIds = new Set(c.packEffects.map((p) => p._id));
    for (const e of c.entries) {
      if (e.auraEffectId) expect(packIds.has(e.auraEffectId)).toBe(true);
    }
  });

  it("has globally unique entry ids", () => {
    const ids = raw.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
