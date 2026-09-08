import { describe, it, expect, beforeEach } from "vitest";

/**
 * A hero point spent on a temptation save used to vanish.
 *
 * pf2e 8.5.0 rerolls by deleting the rolled message and posting a NEW one built
 * from `fu.deepClone(message.flags.pf2e)` (system/check/check.ts:447): our roll
 * option and the temptation id survive, `context.isReroll` is set and
 * "check:reroll" is pushed onto the options (:452-454), and `context.outcome` is
 * overwritten only when the new die is the one kept (:549-554). The first roll had
 * already cleared the pending marker, so the capture bailed on `if (!pending)` and
 * the slide kept a result the table had thrown away. (F2)
 *
 * Foundry globals go up before the dynamic import, the same way
 * test/ansu-reroll.test.mjs does it.
 */
const whispers = [];
const hooks = new Map();
const created = [];

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id1",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = {
  on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  once() {},
  callAll() {},
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [],
  getSpeaker: () => ({}),
  create: async (data) => whispers.push(data.content),
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

const { registerTemptationHooks } = await import("../src/subsystems/izir/mechanics/temptation.mjs");

registerTemptationHooks();
const captures = hooks.get("createChatMessage") ?? [];
const fire = async (message) => {
  for (const fn of captures) await fn(message);
  // The hook body dispatches without awaiting; give its promise chain a turn.
  await new Promise((r) => setTimeout(r, 0));
};

const FLAG = "flags.the-shards-subsystems.izir";

/** A marked actor whose flag survives the dot-path updates patchIzir writes. */
function nameless(state) {
  const flag = {
    enabled: true,
    level: 3,
    slide: 0,
    terminal: null,
    suppressed: [],
    revealed: [],
    log: [],
    pendingTemptation: null,
    ...state,
  };
  return {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Тень",
    type: "npc",
    items: [],
    system: { details: { level: { value: 5 } } },
    getFlag: () => flag,
    createEmbeddedDocuments: async (_t, datas) => created.push(...datas),
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
    update: async (data) => {
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
}

/** A temptation save message shaped the way pf2e posts one. */
const saveMessage = (actor, id, outcome, { reroll = false, total = 12 } = {}) => ({
  actor,
  speaker: {},
  rolls: [{ total }],
  flags: {
    pf2e: {
      context: {
        type: "saving-throw",
        outcome,
        isReroll: reroll,
        options: [
          "shards-izir-temptation",
          `shards-izir-temptation-id:${id}`,
          ...(reroll ? ["check:reroll"] : []),
        ],
      },
    },
  },
});

describe("a rerolled temptation replaces its first result", () => {
  beforeEach(() => {
    whispers.length = 0;
    created.length = 0;
  });

  it("takes the slide back when a failure is rerolled into a success", async () => {
    const actor = nameless({ level: 3, slide: 1, pendingTemptation: { id: "t1", dc: 26, reason: "" } });
    await fire(saveMessage(actor, "t1", "failure"));
    expect(actor.flag.slide).toBe(2);

    await fire(saveMessage(actor, "t1", "success", { reroll: true, total: 30 }));
    expect(actor.flag.slide).toBe(1);
    expect(actor.flag.level).toBe(3);

    const temptations = actor.flag.log.filter((e) => e.type === "temptation");
    expect(temptations).toHaveLength(1);
    expect(temptations[0].data.outcome).toBe("success");
    expect(temptations[0].data.slideDelta).toBe(0);
    expect(temptations[0].data.rerolled).toBe(true);
    // The slide entry the first result wrote is retracted, not left behind.
    expect(actor.flag.log.some((e) => e.type === "slide" && e.data?.cause === "t1")).toBe(false);
  });

  it("deepens further when a failure is rerolled into a critical failure", async () => {
    const actor = nameless({ level: 3, slide: 0, pendingTemptation: { id: "t2", dc: 26, reason: "" } });
    await fire(saveMessage(actor, "t2", "failure"));
    expect(actor.flag.slide).toBe(1);

    await fire(saveMessage(actor, "t2", "criticalFailure", { reroll: true, total: 4 }));
    expect(actor.flag.slide).toBe(2);
    expect(actor.flag.log.filter((e) => e.type === "temptation")).toHaveLength(1);
  });

  it("undoes a level gained on the first result", async () => {
    // Immersion 3 needs 9 points; sitting on 8, a critical failure tips it over.
    const actor = nameless({ level: 3, slide: 8, pendingTemptation: { id: "t3", dc: 26, reason: "" } });
    await fire(saveMessage(actor, "t3", "criticalFailure"));
    expect(actor.flag.level).toBe(4);
    expect(actor.flag.slide).toBe(1);

    await fire(saveMessage(actor, "t3", "success", { reroll: true, total: 31 }));
    expect(actor.flag.level).toBe(3);
    expect(actor.flag.slide).toBe(8);
    expect(actor.flag.log.some((e) => e.type === "level" && e.data?.cause === "t3")).toBe(false);
  });

  it("refuses to replay under a later temptation and says so", async () => {
    const actor = nameless({ level: 3, slide: 0, pendingTemptation: { id: "t4", dc: 26, reason: "" } });
    await fire(saveMessage(actor, "t4", "failure"));
    actor.flag.pendingTemptation = { id: "t5", dc: 29, reason: "" };
    await fire(saveMessage(actor, "t5", "failure"));
    expect(actor.flag.slide).toBe(2);

    await fire(saveMessage(actor, "t4", "success", { reroll: true, total: 30 }));
    expect(actor.flag.slide).toBe(2); // untouched
    expect(whispers.join(" ")).toContain("SHARDS.Izir.RerollTooLate");
  });

  it("records a failure that the slide refused as +0, and says why", async () => {
    // At immersion 0 there is no slide. The history and the exported journal used
    // to read "CF +2" while nothing had moved, and no whisper explained it. (F19)
    const actor = nameless({ level: 0, slide: 0, pendingTemptation: { id: "t6", dc: 20, reason: "" } });
    await fire(saveMessage(actor, "t6", "criticalFailure"));

    const entry = actor.flag.log.find((e) => e.type === "temptation");
    expect(entry.data.slideDelta).toBe(0);
    expect(entry.data.applied).toBe(false);
    expect(whispers.join(" ")).toContain("SHARDS.Izir.SlideInertLevel0");
  });

  it("says nothing moved when the bar is already full at immersion 9", async () => {
    const actor = nameless({ level: 9, slide: 27, pendingTemptation: { id: "t7", dc: 44, reason: "" } });
    await fire(saveMessage(actor, "t7", "failure"));

    expect(actor.flag.slide).toBe(27);
    expect(actor.flag.log.find((e) => e.type === "temptation").data.applied).toBe(false);
    expect(whispers.join(" ")).toContain("SHARDS.Izir.SlideCapped");
  });

  it("ignores a reroll of a save it never recorded", async () => {
    const actor = nameless({ level: 3, slide: 4 });
    await fire(saveMessage(actor, "unknown", "criticalFailure", { reroll: true }));
    expect(actor.flag.slide).toBe(4);
    expect(actor.flag.log).toHaveLength(0);
  });
});
