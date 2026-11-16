import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 0.8.0 performance and lock fixes (audits perf-review.md, findings 1 to 6 and
 * the correctness notes): one actor write per logical step, a per-actor lock
 * for read-modify-write steps, the NPC trait from source data, the token-icon
 * toggle in the composed hash, the panel following outside changes with one
 * redraw per burst, the world-time sweep, the values page skipping no-op writes,
 * and deed notes end to end. Globals go up before the dynamic imports.
 */
const DEEDS = JSON.parse(readFileSync(new URL("../data/ansu/deeds.json", import.meta.url), "utf8"));
const HISTORY_HBS = readFileSync(new URL("../templates/ansu/history-dialog.hbs", import.meta.url), "utf8");
const messages = [];
const hooks = {};
const renders = { count: 0 };
const journal = new Map();

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        constructor() {
          this.rendered = false;
        }
        render() {
          this.rendered = true;
          renders.count += 1;
          return this;
        }
      },
      HandlebarsApplicationMixin: (base) => base,
    },
  },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id9",
    hasProperty: (obj, path) => {
      let node = obj;
      for (const k of path.split(".")) {
        if (node === null || typeof node !== "object" || !(k in node)) return false;
        node = node[k];
      }
      return true;
    },
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
const actorList = [];
let contentsReads = 0;
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}` },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  combats: { contents: [] },
  scenes: { get: () => null, contents: [] },
  actors: {
    get: () => null,
    get contents() {
      contentsReads += 1;
      return actorList;
    },
  },
  journal: { get: (id) => journal.get(id) ?? null },
  time: { worldTime: 1000 },
};
globalThis.CONFIG = { time: { roundTime: 6 } };
globalThis.CONST = { JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 }, DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

/** A journal entry whose page records every text write. */
class JournalEntryMock {
  static async create(data) {
    const e = new JournalEntryMock(data);
    journal.set(e.id, e);
    return e;
  }
  constructor(data) {
    this.id = `j${journal.size + 1}`;
    this.ownership = { ...data.ownership };
    this.ownershipWrites = 0;
    const page = {
      text: { content: data.pages[0].text.content },
      writes: 0,
      update: async (u) => {
        page.text.content = u["text.content"];
        page.writes += 1;
      },
    };
    this.pages = { contents: [page] };
  }
  async update(u) {
    this.ownershipWrites += 1;
    Object.assign(this.ownership, u.ownership ?? {});
  }
}
globalThis.JournalEntry = JournalEntryMock;

const { recordCallOutcome } = await import("../src/subsystems/ansu/mechanics/call.mjs");
const { recordReleaseOutcome } = await import("../src/subsystems/ansu/mechanics/release.mjs");
const { recordConflictOutcome } = await import("../src/subsystems/ansu/mechanics/conflict.mjs");
const { recordDeed, recordDeeds, adjustBar } = await import("../src/subsystems/ansu/mechanics/deeds.mjs");
const { sweepWorldTime } = await import("../src/subsystems/ansu/mechanics/communion.mjs");
const { attuneActor, appendLog, logEntry } = await import("../src/subsystems/ansu/state.mjs");
const { composeAttunement, composeCommunion } = await import("../src/subsystems/ansu/logic/reconcile.mjs");
const { buildAttunementSource } = await import("../src/subsystems/ansu/sync.mjs");
const { openAnsuPanel, refreshAnsuPanel, registerPanelFollowHooks } = await import(
  "../src/subsystems/ansu/apps/ansu-panel.mjs"
);
const { AnsuHistoryDialog } = await import("../src/subsystems/ansu/apps/ansu-dialogs.mjs");

const FLAG = "flags.the-shards-subsystems.ansu";

/** A level-5 NPC bearer at attunement 4. Every `actor.update` is recorded. */
function bearer(state = {}, { hp = 60 } = {}) {
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
    type: "npc",
    items,
    rules: [],
    conditions: [],
    updates: [],
    system: { details: { level: { value: 5 } }, attributes: { hp: { value: hp, max: 60 } } },
    getFlag: () => flag,
    hasCondition: () => false,
    getStatistic: () => ({ roll: async () => {} }),
    increaseCondition: async (slug) => actor.conditions.push(slug),
    testUserPermission: () => true,
    // A server round trip: the write lands a tick later, as in Foundry.
    update: async (data) => {
      actor.updates.push(data);
      await new Promise((r) => setTimeout(r, 1));
      for (const [path, value] of Object.entries(data)) {
        if (path === "system.attributes.hp.value") {
          actor.system.attributes.hp.value = value;
          continue;
        }
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

const types = (actor) => actor.flag.log.map((e) => e.type);

/** A bearer whose values page already exists (the steady state after the first deed). */
function withPage(actor) {
  const entry = new JournalEntryMock({ ownership: { default: 0 }, pages: [{ text: { content: "" } }] });
  journal.set(entry.id, entry);
  actor.flag.valuesJournalId = entry.id;
  return actor;
}

beforeEach(() => {
  messages.length = 0;
  actorList.length = 0;
  journal.clear();
  game.time.worldTime = 1000;
});

describe("one actor write per roll (findings 1 and 2)", () => {
  it("a Call success writes the actor once: the record, both rows and the Communion", async () => {
    const actor = bearer({ pendingCall: { id: "c1", dc: 25, createdAt: 1 } });
    await recordCallOutcome(actor, "success", 27);
    expect(actor.updates).toHaveLength(1);
    expect(types(actor)).toEqual(["call", "communion"]);
    expect(actor.flag.communion.mode).toBe("active");
    expect(actor.flag.pendingCall).toBeNull();
    expect(actor.flag.log[0].note).toBeUndefined(); // the Call row never carried a note
  });

  it("a release failure writes the actor once: record, end of Communion, rows and Hit Points", async () => {
    const actor = bearer({
      communion: { mode: "active", rounds: 3, startAt: null, returnPenalty: 2 },
      pendingRelease: { id: "r1", dc: 28, reason: "time", createdAt: 1 },
    });
    await recordReleaseOutcome(actor, "failure", 20);
    expect(actor.updates).toHaveLength(1);
    expect(types(actor)).toEqual(["release", "communion"]);
    expect(actor.flag.log[0].note).toBe("time");
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.communion.returnPenalty).toBe(0);
    expect(actor.system.attributes.hp.value).toBeLessThan(60);
  });

  it("a release critical failure lands the lockout in the same write", async () => {
    const actor = bearer({
      communion: { mode: "active", rounds: 3, startAt: null, returnPenalty: 0 },
      pendingRelease: { id: "r1", dc: 28, reason: "", createdAt: 1 },
    });
    await recordReleaseOutcome(actor, "criticalFailure", 10);
    expect(actor.updates).toHaveLength(1);
    expect(actor.flag.lockout).toBeTruthy();
    expect(actor.conditions).toContain("fatigued");
  });

  it("a conflict outcome with two deeds writes the actor once, rows in order", async () => {
    const actor = withPage(bearer());
    const record = {
      patch: { pendingConflict: null, lastConflict: { id: "k1", outcome: "success" } },
      log: logEntry("conflict", { id: "k1", stage: "will", dc: 22, outcome: "success" }, "finish him"),
    };
    const out = await recordDeeds(actor, ["argument", "forced-back"], "finish him", { extra: record });
    expect(actor.updates).toHaveLength(1);
    expect(types(actor)).toEqual(["conflict", "deed", "deed"]);
    expect(actor.flag.log.map((e) => e.data.deed ?? null)).toEqual([null, "argument", "forced-back"]);
    expect(actor.flag.loyalty).toBe(6);
    expect(actor.flag.wrath).toBe(1);
    expect(out.map((r) => r?.loyalty)).toEqual([[5, 6], [6, 6]]);
  });

  it("a Will save held by persuasion writes the record and its deed together", async () => {
    const actor = withPage(
      bearer({ pendingConflict: { id: "k1", dc: 22, stage: "will", want: "x", severity: "minor", createdAt: 1 } }),
    );
    await recordConflictOutcome(actor, "success", 25);
    expect(actor.updates).toHaveLength(1);
    expect(types(actor)).toEqual(["conflict", "deed"]);
  });
});

describe("per-actor lock (correctness note 1)", () => {
  it("two quick taps on a bar both count", async () => {
    const actor = bearer();
    await Promise.all([adjustBar(actor, "wrath", +1), adjustBar(actor, "wrath", +1)]);
    expect(actor.flag.wrath).toBe(2);
    expect(actor.flag.log.filter((e) => e.type === "adjust").map((e) => [e.data.from, e.data.to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("two quick deeds both land, each with its row", async () => {
    const actor = bearer();
    await Promise.all([recordDeed(actor, "for-nothing"), recordDeed(actor, "feast")]);
    expect(actor.flag.wrath).toBe(2);
    expect(actor.flag.log.filter((e) => e.type === "deed")).toHaveLength(2);
  });

  it("two log appends at once both keep their row", async () => {
    const actor = bearer();
    await Promise.all([appendLog(actor, "mark", {}), appendLog(actor, "lingering", {})]);
    expect(types(actor)).toEqual(["mark", "lingering"]);
  });
});

describe("NPC trait from source data (correctness note 2)", () => {
  it("attuning writes the source traits plus murkhor, never rule-element traits", async () => {
    const actor = bearer();
    actor.flag.enabled = undefined;
    actor.setFlag = async () => {};
    actor._source = { system: { traits: { value: ["dwarf"] } } };
    actor.system.traits = { value: ["dwarf", "from-a-rule-element"] };
    await attuneActor(actor);
    const write = actor.updates.find((u) => "system.traits.value" in u);
    expect(write["system.traits.value"]).toEqual(["dwarf", "murkhor"]);
  });
});

describe("token-icon setting reaches built markers (correctness note 3)", () => {
  const content = { entries: [], tiers: [] };
  const st = { level: 4, loyalty: 5, wrath: 0, communion: { mode: "active" }, suppressed: [] };

  it("is part of the composed hash of the marker and the Communion", () => {
    const on = composeAttunement(st, content, { charLevel: 5, tokenIcons: true });
    const off = composeAttunement(st, content, { charLevel: 5, tokenIcons: false });
    expect(on.hash).not.toBe(off.hash);
    expect(buildAttunementSource(off).system.tokenIcon.show).toBe(false);
    expect(buildAttunementSource(on).system.tokenIcon.show).toBe(true);
    const c1 = composeCommunion(st, content, { charLevel: 5, tokenIcons: true });
    const c2 = composeCommunion(st, content, { charLevel: 5, tokenIcons: false });
    expect(c1.hash).not.toBe(c2.hash);
  });

  it("the setting resyncs on change", () => {
    const src = readFileSync(new URL("../src/subsystems/ansu/index.mjs", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("SETTINGS.ANSU_TOKEN_ICONS"));
    expect(line).toMatch(/onChange: resyncOnChange/);
  });
});

describe("panel redraws (findings 4 and correctness note 4)", () => {
  afterEach(() => vi.useRealTimers());

  it("a burst of refreshes redraws once", () => {
    vi.useFakeTimers();
    openAnsuPanel("Actor.a1");
    renders.count = 0;
    for (let i = 0; i < 6; i += 1) refreshAnsuPanel();
    expect(renders.count).toBe(0);
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(1);
  });

  it("follows an Ansu flag change, a token drop and a turn change made elsewhere", () => {
    vi.useFakeTimers();
    registerPanelFollowHooks();
    openAnsuPanel("Actor.a1");
    const fire = (name, ...args) => (hooks[name] ?? []).forEach((fn) => fn(...args));

    renders.count = 0;
    fire("updateActor", {}, { flags: { "the-shards-subsystems": { ansu: { loyalty: 6 } } } });
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(1);

    fire("updateActor", {}, { system: { attributes: { hp: { value: 3 } } } });
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(1);

    fire("createToken", {});
    vi.advanceTimersByTime(60);
    fire("updateCombat", {}, { turn: 2 });
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(3);

    fire("updateCombat", {}, { flags: {} });
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(3);
  });
});

describe("world-time sweep (finding 3)", () => {
  afterEach(() => vi.useRealTimers());

  it("does nothing, and redraws nothing, when no bearer has a cooldown, lockout or running Communion", async () => {
    actorList.push(bearer());
    openAnsuPanel("Actor.a1");
    renders.count = 0;
    contentsReads = 0;
    const changed = await sweepWorldTime(6);
    await new Promise((r) => setTimeout(r, 80));
    expect(changed).toBe(false);
    expect(renders.count).toBe(0);
    expect(contentsReads).toBe(1); // one walk, not two
  });

  it("prunes a lapsed cooldown with one walk and redraws once", async () => {
    const actor = bearer({ cooldowns: [{ id: "the-ansu-refuses", until: 900 }] });
    actorList.push(actor);
    openAnsuPanel("Actor.a1");
    renders.count = 0;
    contentsReads = 0;
    expect(await sweepWorldTime(6)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(actor.flag.cooldowns).toEqual([]);
    expect(contentsReads).toBe(1);
    expect(renders.count).toBe(1);
  });

  it("a cooldown still running changes nothing and redraws nothing", async () => {
    actorList.push(bearer({ cooldowns: [{ id: "the-ansu-refuses", until: 5000 }] }));
    openAnsuPanel("Actor.a1");
    renders.count = 0;
    expect(await sweepWorldTime(6)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(renders.count).toBe(0);
  });
});

describe("values page (finding 6)", () => {
  it("skips the page and ownership writes when nothing changed", async () => {
    const actor = bearer();
    await recordDeed(actor, "argument");
    const entry = journal.get(actor.flag.valuesJournalId);
    expect(entry).toBeTruthy();
    const page = entry.pages.contents[0];
    const { rebuildValuesPage } = await import("../src/subsystems/ansu/journal.mjs");
    await rebuildValuesPage(actor);
    expect(page.writes).toBe(0);
    expect(entry.ownershipWrites).toBe(0);
    await recordDeed(actor, "feast");
    expect(page.writes).toBe(1);
  });
});

/** The History dialog's row, through the template's own markup for one entry. */
function historyRowText(row) {
  const li = HISTORY_HBS.match(/<span class="ansu-log-desc">([\s\S]*?)<\/span>/)[1];
  return li
    .replace(/\{\{#if this\.note\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, inner) => (row.note ? inner : ""))
    .replace(/\{\{this\.(\w+)\}\}/g, (_m, k) => String(row[k] ?? ""));
}

describe("deed notes end to end (item 5)", () => {
  const LABEL = DEEDS.deeds.find((d) => d.id === "argument").label;

  it("shows the deed label and the note in the History rows and on the values page", async () => {
    const actor = bearer();
    globalThis.fromUuidSync = (uuid) => (uuid === actor.uuid ? actor : null);
    await recordDeed(actor, "argument", "spoke for the clan");

    const ctx = await new AnsuHistoryDialog(actor.uuid)._prepareContext();
    const row = ctx.entries.find((e) => e.type === "deed");
    expect(row.desc).toContain(LABEL);
    expect(row.note).toBe("spoke for the clan");
    expect(historyRowText(row)).toContain(LABEL);
    expect(historyRowText(row)).toContain("(<em>spoke for the clan</em>)");

    const html = journal.get(actor.flag.valuesJournalId).pages.contents[0].text.content;
    expect(html).toContain(LABEL);
    expect(html).toContain("spoke for the clan");
  });

  it("an empty note leaves no empty brackets anywhere", async () => {
    const actor = bearer();
    globalThis.fromUuidSync = (uuid) => (uuid === actor.uuid ? actor : null);
    await recordDeed(actor, "argument", "");

    const ctx = await new AnsuHistoryDialog(actor.uuid)._prepareContext();
    const row = ctx.entries.find((e) => e.type === "deed");
    expect(row.desc).toContain(LABEL);
    const text = historyRowText(row);
    expect(text).not.toMatch(/\(\s*(<em>\s*<\/em>)?\s*\)/);

    const html = journal.get(actor.flag.valuesJournalId).pages.contents[0].text.content;
    expect(html).toContain(LABEL);
    expect(html).not.toMatch(/\(\s*(<em>\s*<\/em>)?\s*\)/);
  });
});
