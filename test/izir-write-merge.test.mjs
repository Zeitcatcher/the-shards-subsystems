import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * 0.8.0 (perf-review findings 1 and 4, Izir side): a failed temptation writes
 * the actor once (marker cleared, slide moved, rows slide / level / temptation
 * in their old order), and a burst of panel refreshes redraws the Izir panel
 * once. Globals go up before the dynamic imports.
 */
const renders = { count: 0 };

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
    randomID: () => "id1",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = {
  getWhisperRecipients: () => [],
  getSpeaker: () => ({}),
  create: async () => {},
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  scenes: { get: () => null, contents: [] },
  actors: { get: () => null, contents: [] },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { recordTemptationOutcome } = await import("../src/subsystems/izir/mechanics/temptation.mjs");
const { applySlide } = await import("../src/subsystems/izir/logic/model.mjs");
const { openIzirPanel, refreshIzirPanel } = await import("../src/subsystems/izir/apps/izir-panel.mjs");

const FLAG = "flags.the-shards-subsystems.izir";

function nameless(state) {
  const flag = {
    enabled: true,
    level: 3,
    slide: 0,
    terminal: null,
    suppressed: [],
    revealed: [],
    log: [],
    pendingTemptation: { id: "t1", dc: 20, reason: "the blood", createdAt: 1 },
    ...state,
  };
  const actor = {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Shade",
    type: "npc",
    items: [],
    updates: [],
    system: { details: { level: { value: 5 } } },
    getFlag: () => flag,
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
    update: async (data) => {
      actor.updates.push(data);
      for (const [path, value] of Object.entries(data)) {
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
  };
  return actor;
}

describe("a failed temptation writes the actor once", () => {
  it("clears the marker, moves the slide and logs slide then temptation in one update", async () => {
    const actor = nameless();
    await recordTemptationOutcome(actor, "failure", 12);
    expect(actor.updates).toHaveLength(1);
    expect(actor.flag.log.map((e) => e.type)).toEqual(["slide", "temptation"]);
    expect(actor.flag.pendingTemptation).toBeNull();
    expect(actor.flag.slide).toBe(1);
    expect(actor.flag.log[1].note).toBe("the blood");
    expect(actor.flag.log[1].data.applied).toBe(true);
  });

  it("a slide that raises the level adds the level row in the same update", async () => {
    let s = 0;
    while (!applySlide(3, s, 1).leveled) s += 1;
    const actor = nameless({ slide: s });
    await recordTemptationOutcome(actor, "failure", 12);
    expect(actor.flag.log.map((e) => e.type)).toEqual(["slide", "level", "temptation"]);
    expect(actor.flag.level).toBe(4);
    // One flag write; any further writes are the item sync's, not the actor's.
    expect(actor.updates).toHaveLength(1);
  });

  it("a passed save clears the marker and logs in one update", async () => {
    const actor = nameless();
    await recordTemptationOutcome(actor, "success", 25);
    expect(actor.updates).toHaveLength(1);
    expect(actor.flag.log.map((e) => e.type)).toEqual(["temptation"]);
    expect(actor.flag.log[0].data.applied).toBe(false);
  });
});

describe("Izir panel redraws once per burst", () => {
  afterEach(() => vi.useRealTimers());

  it("six refreshes, one redraw", () => {
    vi.useFakeTimers();
    openIzirPanel();
    renders.count = 0;
    for (let i = 0; i < 6; i += 1) refreshIzirPanel();
    vi.advanceTimersByTime(60);
    expect(renders.count).toBe(1);
  });
});
