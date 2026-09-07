import { describe, it, expect, beforeEach } from "vitest";

/**
 * The Call capture, end to end on a bearer whose flag really mutates.
 *
 * Two defects live here. A roll from a SUPERSEDED card was thrown away with no
 * warning and no feedback, even though `requestInvoke` deliberately replaces a
 * stale pending Call and two live cards are therefore reachable (item 15). And a
 * critical failure told the GM twice, once with the wrong ending: `startSeizure`
 * whispered "then Lingering resumes" while `call.mjs` whispered "then Communion
 * continues under the player", one line apart (items 11 and 30).
 *
 * Globals go up before the dynamic import, the same way ansu-reroll.test.mjs
 * does it.
 */
const messages = [];
const hooks = new Map();
const warnings = [];

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "fresh1",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = {
  on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  once() {},
  callAll() {},
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [{ id: "gm1" }],
  getSpeaker: () => ({}),
  create: async (data) => messages.push(data.content),
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}` },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  combats: { contents: [] },
  scenes: { get: () => null },
  actors: { get: () => null },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { registerCallHooks, recordCallOutcome } = await import("../src/subsystems/ansu/mechanics/call.mjs");
registerCallHooks();
const captures = hooks.get("createChatMessage") ?? [];

const FLAG = "flags.the-shards-subsystems.ansu";

/** A bearer whose flag survives the dot-path updates patchAnsu writes. */
function bearer(state) {
  const flag = {
    enabled: true,
    level: 4,
    climb: 2,
    terminal: null,
    communion: { mode: "none", rounds: null, startAt: null },
    log: [],
    ...state,
  };
  const items = [];
  items.get = () => undefined;
  return {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Грог",
    items,
    rules: [],
    system: { details: { level: { value: 5 } } },
    getFlag: () => flag,
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
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
  };
}

/** An Intimidation check message shaped the way pf2e posts one from the card. */
const callMessage = (actor, { id, outcome, total = 12 }) => ({
  actor,
  speaker: {},
  rolls: [{ total }],
  flags: {
    pf2e: {
      context: {
        type: "skill-check",
        outcome,
        options: ["shards-ansu-call", `shards-ansu-call-id:${id}`],
      },
    },
  },
});

/** The capture hooks are fire-and-forget; let their promise chains settle. */
async function fire(message) {
  for (const fn of captures) fn(message);
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  messages.length = 0;
  warnings.length = 0;
  console.warn = (...args) => warnings.push(args.join(" "));
});

describe("a Call rolled from a superseded card", () => {
  const open = { pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() } };

  it("is recorded anyway, with a warning naming both ids", async () => {
    const actor = bearer(open);
    await fire(callMessage(actor, { id: "stale0", outcome: "failure" }));

    expect(actor.flag.pendingCall).toBeNull();
    expect(actor.flag.lastCall).toMatchObject({ outcome: "failure" });
    expect(warnings.join("\n")).toContain("stale0");
    expect(warnings.join("\n")).toContain("fresh1");
  });

  it("says nothing when the card that was rolled is the open one", async () => {
    const actor = bearer(open);
    await fire(callMessage(actor, { id: "fresh1", outcome: "failure" }));

    expect(actor.flag.lastCall).toMatchObject({ id: "fresh1", outcome: "failure" });
    expect(warnings.join("\n")).not.toContain("recording it anyway");
  });

  it("still ignores a skill check carrying none of our options", async () => {
    const actor = bearer(open);
    await fire({
      actor,
      speaker: {},
      rolls: [{ total: 30 }],
      flags: { pf2e: { context: { type: "skill-check", outcome: "success", options: ["action:demoralize"] } } },
    });

    expect(actor.flag.pendingCall).toEqual(open.pendingCall);
  });
});

describe("a critical failure on the Call", () => {
  it("takes the body, snapshots the open card, and reports the landing once", async () => {
    const actor = bearer({ pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() } });
    await recordCallOutcome(actor, "criticalFailure", 3);

    expect(actor.flag.communion.mode).toBe("seized");
    expect(actor.flag.seizure).toMatchObject({ auto: true, thenMode: "active" });
    // The snapshot holds the state as it was BEFORE the Call was recorded.
    expect(actor.flag.seizure.snapshot).toHaveProperty("pendingCall");
    expect(actor.flag.pendingCall).toBeNull();

    const seizureCards = messages.filter((m) => m.includes("SeizureAutoStart"));
    expect(seizureCards).toHaveLength(1);
    expect(seizureCards[0]).toContain("SHARDS.Ansu.SeizureAutoStartActive");
    // The old duplicate said the same thing with the wrong ending.
    expect(messages.some((m) => m.includes("CallCritFailReport"))).toBe(false);
  });

  it("reports nothing about a seizure when the Ansu already has the body", async () => {
    const actor = bearer({
      communion: { mode: "seized", rounds: null, startAt: null },
      seizure: { snapshot: {}, at: Date.now(), auto: false, thenMode: "lingering" },
      pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() },
    });
    await recordCallOutcome(actor, "criticalFailure", 3);

    expect(messages.some((m) => m.includes("SeizureAutoStart"))).toBe(false);
    expect(messages.some((m) => m.includes("SHARDS.Ansu.CallCritFailHeld"))).toBe(true);
    // The manual hold is untouched: its snapshot is still the one that returns.
    expect(actor.flag.seizure.auto).toBe(false);
  });
});
