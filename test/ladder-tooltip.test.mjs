import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { escapeHtml, tipHtml, TipCache } from "../src/core/ladder-tooltip.mjs";
import { ansuLadderTip } from "../src/subsystems/ansu/logic/tooltip.mjs";
import { izirLadderTip } from "../src/subsystems/izir/logic/tooltip.mjs";
import { emptyAnsuState } from "../src/subsystems/ansu/state.mjs";
import { emptyIzirState } from "../src/subsystems/izir/state.mjs";
import { buildCtx as ansuCtx, injectNumbers as ansuInject } from "../src/subsystems/ansu/logic/reconcile.mjs";
import { izirDC } from "../src/subsystems/izir/logic/model.mjs";

/**
 * Hover descriptions for the panels' ladder chips: the pure half (the baked
 * text per entry and state, the cache key, the popup markup).
 */

const ANSU = JSON.parse(readFileSync(new URL("../data/ansu/content.json", import.meta.url), "utf8"));
const IZIR = JSON.parse(readFileSync(new URL("../data/izir/content.json", import.meta.url), "utf8"));
const ansuEntry = (id) => ANSU.entries.find((e) => e.id === id);
const izirEntry = (id) => IZIR.entries.find((e) => e.id === id);
const ansu = (patch = {}) => ({ ...emptyAnsuState(), ...patch });
const izir = (patch = {}) => ({ ...emptyIzirState(), ...patch });

describe("tipHtml", () => {
  it("puts name, cost, level and tag in the header and the body below", () => {
    const html = tipHtml({ name: "Call the Blade", cost: "◆", levelLabel: "Attunement 3", tag: "40 ft", bodyHtml: "<p>x</p>" });
    expect(html).toBe(
      '<header class="shards-tip-head"><strong class="shards-tip-name">Call the Blade</strong>' +
        '<span class="shards-tip-cost">◆</span><span class="shards-tip-level">Attunement 3</span>' +
        '<span class="shards-tip-tag">40 ft</span></header><div class="shards-tip-body"><p>x</p></div>',
    );
  });

  it("escapes header text and leaves out empty parts", () => {
    const html = tipHtml({ name: "<b>&", bodyHtml: "" });
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).not.toContain("shards-tip-cost");
    expect(html).not.toContain("shards-tip-tag");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });
});

describe("TipCache", () => {
  it("drops the oldest key past its limit and refreshes a re-set key", () => {
    const c = new TipCache(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 3);
    c.set("c", 4);
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(3);
    expect(c.size).toBe(2);
  });
});

describe("ansuLadderTip", () => {
  it("bakes the bearer's live numbers on an unlocked row, like the sheet", () => {
    const entry = ansuEntry("call-the-blade");
    const st = ansu({ level: 6, loyalty: 8 });
    const tip = ansuLadderTip(entry, st, { charLevel: 9 });
    const ctx = ansuCtx(9, 6, {}, { loyalty: 8 });
    expect(tip.text).toBe(ansuInject(entry.description, ctx));
    expect(tip.text).toContain("as far as 80 feet");
    expect(tip.text).toContain("Uses per Communion: 3."); // 2 at level 6, +1 in the trust band
    expect(tip.text).not.toContain("{{");
    expect(tip).toMatchObject({ entryId: "call-the-blade", name: "Call the Blade", level: 3, cost: "◆", tag: "80 ft · 3/communion" });
  });

  it("previews a locked row at its own unlock level", () => {
    const tip = ansuLadderTip(ansuEntry("salbarine-parry"), ansu({ level: 1 }), { charLevel: 5 });
    expect(tip.text).toContain(`equal to ${ansuCtx(5, 5).parry}`);
    expect(tip.cost).toBe("↺");
  });

  it("reads a takeover's numbers, as the sheet does", () => {
    const st = ansu({ level: 3, communion: { ...emptyAnsuState().communion, mode: "seized" } });
    const tip = ansuLadderTip(ansuEntry("call-the-blade"), st, { charLevel: 9 });
    expect(tip.text).toContain("as far as 80 feet"); // takeover cap 6
  });

  it("changes its cache key with the state and keeps it for the same state", () => {
    const e = ansuEntry("call-the-blade");
    const a = ansuLadderTip(e, ansu({ level: 6, loyalty: 5 }), { charLevel: 9 });
    const b = ansuLadderTip(e, ansu({ level: 6, loyalty: 5 }), { charLevel: 9 });
    const c = ansuLadderTip(e, ansu({ level: 6, loyalty: 9 }), { charLevel: 9 });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key.startsWith("call-the-blade:")).toBe(true);
  });

  it("covers every entry with no token left unbaked", () => {
    for (const e of ANSU.entries) {
      const tip = ansuLadderTip(e, ansu({ level: 2 }), { charLevel: 4 });
      expect(tip.text, e.id).not.toMatch(/\{\{ansu/);
      expect(tip.name, e.id).toBe(e.name);
    }
  });
});

describe("izirLadderTip", () => {
  it("bakes the bearer's DC into an inline check and shows cost and recharge", () => {
    const tip = izirLadderTip(izirEntry("umbral-grasp"), izir({ level: 4 }), { charLevel: 7 });
    expect(tip.text).toContain(`@Check[fortitude|dc:${izirDC(7, 4)}]`);
    expect(tip).toMatchObject({ level: 2, cost: "◆◆", tag: "R 1d6" });
  });

  it("uses the bearer's immersion for a locked row too, like its chip tag", () => {
    const tip = izirLadderTip(izirEntry("umbral-grasp"), izir({ level: 0 }), { charLevel: 7 });
    expect(tip.text).toContain(`dc:${izirDC(7, 1)}]`);
  });

  it("shows banes in full and leaves no token unbaked", () => {
    for (const e of IZIR.entries) {
      const tip = izirLadderTip(e, izir({ level: 3 }), { charLevel: 5 });
      expect(tip.text, e.id).not.toMatch(/\{\{izir/);
    }
    const bane = IZIR.entries.find((e) => e.kind === "bane");
    expect(izirLadderTip(bane, izir({ level: 1 }), { charLevel: 3 }).text.length).toBeGreaterThan(0);
  });

  it("keys on the state", () => {
    const e = izirEntry("umbral-grasp");
    expect(izirLadderTip(e, izir({ level: 4 }), { charLevel: 7 }).key).not.toBe(izirLadderTip(e, izir({ level: 5 }), { charLevel: 7 }).key);
  });
});
