import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rework step E (spec section 7): the panel's loyalty and wrath bars, the deed
 * picker data, the night's rest (button and pf2e's rest message), the player's
 * Attunement description and the "What the Ansu values" page. Globals go up
 * before the dynamic import, as in ansu-conflict-flow.test.mjs.
 */
const DEEDS = JSON.parse(readFileSync(new URL("../data/ansu/deeds.json", import.meta.url), "utf8"));
const messages = [];
const hooks = {};
const journals = [];
const users = { contents: [], activeGM: { id: "gm1" } };

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id9",
    fetchJsonWithTimeout: async (path) =>
      path.endsWith("deeds.json") ? DEEDS : { version: 1, entries: [], tiers: [] },
  },
};
globalThis.Hooks = {
  on(name, fn) {
    (hooks[name] ??= []).push(fn);
  },
  once() {},
  callAll() {},
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [{ id: "gm1" }],
  getSpeaker: () => ({}),
  create: async (data) => messages.push({ content: data.content, whisper: data.whisper ?? null }),
};
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 }, JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
globalThis.JournalEntry = {
  create: async (data) => {
    const page = { content: data.pages[0].text.content, update: async (u) => (page.content = u["text.content"]) };
    const entry = {
      id: `j${journals.length + 1}`,
      name: data.name,
      ownership: data.ownership,
      pages: { contents: [page] },
      update: async (u) => Object.assign(entry, u),
    };
    journals.push(entry);
    return entry;
  },
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}` },
  settings: { get: () => "gm" },
  users,
  user: { id: "gm1", isGM: true },
  journal: { get: (id) => journals.find((j) => j.id === id) ?? null },
  combats: { contents: [] },
  scenes: { get: () => null },
  actors: { get: () => null },
  time: { worldTime: 1000 },
};
globalThis.CONFIG = { time: { roundTime: 6 } };
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const panel = await import("../src/subsystems/ansu/logic/panel.mjs");
const { composeAttunement } = await import("../src/subsystems/ansu/logic/reconcile.mjs");
const { buildAttunementSource } = await import("../src/subsystems/ansu/sync.mjs");
const { recordDeed, adjustBar, restForNight, onRestMessage, registerRestHooks } = await import(
  "../src/subsystems/ansu/mechanics/deeds.mjs"
);
const { startConflict } = await import("../src/subsystems/ansu/mechanics/conflict.mjs");
const { indexDeeds } = await import("../src/subsystems/ansu/logic/deeds.mjs");

registerRestHooks();

const FLAG = "flags.the-shards-subsystems.ansu";

function bearer(state = {}) {
  const flag = {
    enabled: true,
    level: 4,
    loyalty: 5,
    wrath: 0,
    terminal: null,
    communion: { mode: "none", rounds: null, startAt: null, returnPenalty: 0 },
    log: [],
    ...state,
  };
  const items = [];
  items.get = () => undefined;
  items.find = () => undefined;
  const actor = {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Bearer",
    items,
    rules: [],
    rolled: [],
    system: { details: { level: { value: 9 } }, attributes: { hp: { value: 60, max: 60 } } },
    getFlag: () => flag,
    hasCondition: () => false,
    getStatistic: (slug) => ({ roll: async (args) => actor.rolled.push({ slug, args }) }),
    testUserPermission: (u) => u.id === "p1",
    update: async (data) => {
      for (const [path, value] of Object.entries(data)) {
        if (!path.startsWith(FLAG)) continue;
        const keys = path.replace(`${FLAG}.`, "").split(".");
        let node = flag;
        while (keys.length > 1) {
          const k = keys.shift();
          if (node[k] === null || typeof node[k] !== "object") node[k] = {};
          node = node[k];
        }
        node[keys[0]] = value;
      }
    },
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
  };
  return actor;
}

beforeEach(() => {
  messages.length = 0;
  journals.length = 0;
  users.contents = [];
});

describe("loyalty and wrath bars", () => {
  it("loyalty: value, band, Call adjustment and band-coloured segments", () => {
    const v = panel.loyaltyView(7);
    expect(v).toMatchObject({ value: 7, max: 10, band: "trust", adjust: -1, adjustText: "-1" });
    expect(v.segments).toHaveLength(10);
    expect(v.segments.filter((s) => s.filled)).toHaveLength(7);
    expect(v.segments.map((s) => s.band).slice(0, 4)).toEqual(["cold", "cold", "cold", "wary"]);
    expect(panel.loyaltyView(0)).toMatchObject({ band: "hostile", adjustText: "+2" });
    expect(panel.loyaltyView("junk").value).toBe(5);
  });
  it("wrath: value, band and the conflict DC bump from 3", () => {
    expect(panel.wrathView(2)).toMatchObject({ value: 2, band: "calm", bump: 0, bumpText: "+0" });
    expect(panel.wrathView(3)).toMatchObject({ band: "angry", bump: 2, bumpText: "+2" });
    expect(panel.wrathView(9)).toMatchObject({ value: 6, band: "breaking" });
    expect(panel.wrathView(4).segments).toHaveLength(6);
  });
});

describe("deeds for the picker and the values page", () => {
  const idx = indexDeeds(DEEDS);
  it("deedEffect keeps a wrath set apart from a wrath move", () => {
    expect(panel.deedEffect(idx.byId.get("task"))).toMatchObject({ loyalty: 2, wrath: null, wrathSet: 0 });
    expect(panel.deedEffect(idx.byId.get("victory"))).toMatchObject({ loyalty: 1, wrath: -1, wrathSet: null });
  });
  it("groups the values table by effect, best first, without the Ansu's outlets or the rest", () => {
    const rows = panel.valuesRows(DEEDS.deeds);
    const all = rows.flatMap((r) => r.labels);
    for (const id of panel.VALUES_HIDDEN) expect(all).not.toContain(idx.byId.get(id).label);
    expect(rows[0]).toMatchObject({ loyalty: 2, wrathSet: 0, tone: "good" });
    expect(rows.at(-1)).toMatchObject({ loyalty: -2, wrath: 2, tone: "bad" });
    const plusOne = rows.find((r) => r.key === "1|d-1");
    expect(plusOne.labels).toEqual(expect.arrayContaining([idx.byId.get("victory").label, idx.byId.get("together").label]));
    expect(rows.find((r) => r.key === "0|d1").tone).toBe("warn");
  });
  it("lists the last ten deed lines newest first, with labels", () => {
    const log = Array.from({ length: 12 }, (_, i) => ({
      t: i,
      type: "deed",
      data: { deed: i % 2 ? "victory" : "feast", loyalty: [5, 5], wrath: [0, 1] },
      note: i === 11 ? "the arena" : "",
    }));
    log.push({ t: 99, type: "release", data: {} });
    const lines = panel.deedLogLines(log, idx.byId, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatchObject({ t: 11, deed: "victory", note: "the arena", label: idx.byId.get("victory").label });
    expect(lines.at(-1).t).toBe(2);
  });
});

describe("lockout, lengths and the next-level rule", () => {
  it("lockoutView: none, until rest, or seconds left", () => {
    expect(panel.lockoutView(null, 100)).toBeNull();
    expect(panel.lockoutView({ until: 90, untilRest: false }, 100)).toBeNull();
    expect(panel.lockoutView({ until: 160, untilRest: false }, 100)).toEqual({ untilRest: false, seconds: 60 });
    expect(panel.lockoutView({ until: null, untilRest: true }, 100)).toEqual({ untilRest: true, seconds: null });
  });
  it("shortTime", () => {
    expect(panel.shortTime(45)).toBe("45 s");
    expect(panel.shortTime(600)).toBe("10 min");
    expect(panel.shortTime(3600)).toBe("1 h");
  });
  it("lengthsFor reads the duration table", () => {
    expect(panel.lengthsFor(2)).toEqual({ cs: 10, s: 3, f: 1 });
    expect(panel.lengthsFor(5)).toEqual({ cs: 10, s: 5, f: 2 });
    expect(panel.lengthsFor(8)).toEqual({ cs: 100, s: 10, f: 3 });
  });
  it("nextLevelRule: open below the gate, capped at it, the GM's fork at 9", () => {
    expect(panel.nextLevelRule({ level: 3 }, 9)).toMatchObject({ gate: 4, canRise: true, atNinth: false });
    expect(panel.nextLevelRule({ level: 4 }, 9)).toMatchObject({ gate: 4, canRise: false });
    expect(panel.nextLevelRule({ level: 9 }, 20)).toMatchObject({ canRise: false, atNinth: true });
    expect(panel.nextLevelRule({ level: 0 }, 20).canRise).toBe(false);
  });
});

describe("the player's Attunement effect", () => {
  const CONTENT = { entries: [] };
  const st = (over = {}) => ({
    enabled: true, level: 4, terminal: null, suppressed: [], loyalty: 7, wrath: 3,
    communion: { mode: "none", rounds: null }, log: [], ...over,
  });
  it("composes loyalty, wrath, bands, lengths and the gate", () => {
    const c = composeAttunement(st(), CONTENT, { charLevel: 9 });
    expect(c).toMatchObject({
      loyalty: 7, loyaltyBand: "trust", callAdjust: -1, wrath: 3, wrathBand: "angry",
      lengths: { cs: 10, s: 5, f: 2 }, gate: 4, callDc: 27,
    });
  });
  it("re-hashes when loyalty, wrath or the gate moves, so the sheet never quotes stale bars", () => {
    const base = composeAttunement(st(), CONTENT, { charLevel: 9 }).hash;
    expect(composeAttunement(st({ loyalty: 8 }), CONTENT, { charLevel: 9 }).hash).not.toBe(base);
    expect(composeAttunement(st({ wrath: 2 }), CONTENT, { charLevel: 9 }).hash).not.toBe(base);
    expect(composeAttunement(st(), CONTENT, { charLevel: 11 }).hash).not.toBe(base);
    expect(composeAttunement(st(), CONTENT, { charLevel: 9 }).hash).toBe(base);
  });
  it("the description names level, loyalty and band, wrath and band, and the next-level rule", () => {
    const html = buildAttunementSource(composeAttunement(st(), CONTENT, { charLevel: 9 })).system.description.value;
    expect(html).toContain("SHARDS.Ansu.MarkerLoyalty 7 SHARDS.Ansu.LoyaltyBand.trust -1");
    expect(html).toContain("SHARDS.Ansu.MarkerWrath 3 SHARDS.Ansu.WrathBand.angry");
    expect(html).toContain("SHARDS.Ansu.MarkerLengths 27 1 minute 5 rounds 2 rounds 28");
    expect(html).toContain("SHARDS.Ansu.MarkerNextGated 4");
    const open = buildAttunementSource(composeAttunement(st({ level: 2 }), CONTENT, { charLevel: 9 })).system.description.value;
    expect(open).toContain("SHARDS.Ansu.MarkerNext 4");
  });
});

describe("bars, deeds and the night's rest on a bearer", () => {
  it("+1 / -1 clamps, logs an adjust line and does nothing at the edge", async () => {
    const actor = bearer({ loyalty: 10, wrath: 0 });
    expect(await adjustBar(actor, "loyalty", +1)).toBeNull();
    expect(await adjustBar(actor, "wrath", -1)).toBeNull();
    expect(await adjustBar(actor, "wrath", +1)).toBe(1);
    expect(actor.flag.log.at(-1)).toMatchObject({ type: "adjust", data: { bar: "wrath", from: 0, to: 1 } });
    expect(actor.flag.level).toBe(4); // no level-up from a bare adjustment
  });

  it("a recorded deed rebuilds the values page, readable by the actor's owner only", async () => {
    users.contents = [{ id: "p1", isGM: false }, { id: "p2", isGM: false }, { id: "gm1", isGM: true }];
    const actor = bearer();
    await recordDeed(actor, "victory", "the crossbowmen");
    expect(journals).toHaveLength(1);
    expect(journals[0].ownership).toEqual({ default: 0, p1: 2 });
    expect(actor.flag.valuesJournalId).toBe("j1");
    const html = journals[0].pages.contents[0].content;
    expect(html).toContain("Hard-won victory over a strong enemy");
    expect(html).toContain("(the crossbowmen)");
    await recordDeed(actor, "feast");
    expect(journals).toHaveLength(1);
    expect(journals[0].pages.contents[0].content.indexOf("lower races")).toBeGreaterThan(-1);
  });

  it("a night's rest drops wrath, clears a rest lockout and the agreed takeover, and logs the night", async () => {
    const actor = bearer({ wrath: 3, lockout: { until: null, untilRest: true }, consentUsed: true });
    const r = await restForNight(actor);
    expect(r).toEqual({ wrath: [3, 2], lockoutCleared: true, consentReset: true });
    expect(actor.flag).toMatchObject({ wrath: 2, lockout: null, consentUsed: false });
    expect(actor.flag.log.at(-1)).toMatchObject({ type: "deed", data: { deed: "night", wrath: [3, 2] } });
  });

  it("a rest that moves nothing writes nothing; at loyalty 0 wrath stays", async () => {
    const calm = bearer({ wrath: 0 });
    await restForNight(calm);
    expect(calm.flag.log).toHaveLength(0);
    const hostile = bearer({ loyalty: 0, wrath: 4, consentUsed: true });
    await restForNight(hostile);
    expect(hostile.flag.wrath).toBe(4);
    expect(hostile.flag.consentUsed).toBe(false);
    expect(hostile.flag.log).toHaveLength(0);
  });

  it("pf2e's Rest for the Night message runs the rest for an attuned speaker", async () => {
    expect(hooks.createChatMessage).toHaveLength(1);
    const actor = bearer({ wrath: 2 });
    expect(onRestMessage({ speakerActor: actor }, {})).toBeNull();
    await onRestMessage({ speakerActor: actor }, { restForTheNight: true });
    expect(actor.flag.wrath).toBe(1);
    const stranger = { getFlag: () => null };
    expect(onRestMessage({ speakerActor: stranger }, { restForTheNight: true })).toBeNull();
  });
});

describe("the conflict's Will save is mental", () => {
  it("the player's Will check carries traits:mental; Diplomacy and Intimidation do not", async () => {
    users.contents = [{ id: "p1", isGM: false }];
    const actor = bearer();
    await startConflict(actor, { want: "x", severity: "minor" });
    const card = messages.find((m) => m.content.includes("ConflictCardTitle")).content;
    expect(card).toMatch(/@Check\[will\|dc:\d+\|traits:mental\|/);
    expect(card).not.toMatch(/@Check\[diplomacy[^\]]*mental/);
    expect(card).not.toMatch(/@Check\[intimidation[^\]]*mental/);
  });
  it("an NPC's Will roll carries the mental trait", async () => {
    const actor = bearer();
    actor.testUserPermission = () => false;
    await startConflict(actor, { want: "x", severity: "minor" });
    expect(actor.rolled[0]).toMatchObject({ slug: "will", args: { traits: ["mental"] } });
  });
});
