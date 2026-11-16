import { describe, it, expect, beforeEach } from "vitest";

/**
 * The Call capture, end to end on a bearer whose flag really mutates.
 *
 * Two defects live here. A roll from a SUPERSEDED card was thrown away with no
 * warning and no feedback, even though `requestInvoke` deliberately replaces a
 * stale pending Call and two live cards are therefore reachable (item 15). Since
 * 0.8 the outcomes stamp the Communion length, and a critical failure locks the
 * Call out and posts the release instead of seizing the body.
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

/** An Athletics check message shaped the way pf2e posts one from the card. */
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

/** The NPC release path rolls a save through getStatistic; record what it was asked. */
function withWill(actor) {
  actor.rolled = [];
  actor.getStatistic = (slug) => ({ roll: async (args) => actor.rolled.push({ slug, args }) });
  return actor;
}

describe("a critical failure on the Call (0.8)", () => {
  it("grants no Communion, locks the Call out for a minute, and posts the release at once", async () => {
    const actor = withWill(bearer({ pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() } }));
    await recordCallOutcome(actor, "criticalFailure", 3);

    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.communion.returnPenalty).toBe(0);
    expect(actor.flag.lockout).toEqual({ until: 60, untilRest: false });
    expect(actor.flag.seizure ?? null).toBeNull();
    expect(actor.flag.pendingCall).toBeNull();
    expect(actor.rolled.map((r) => r.slug)).toEqual(["fortitude"]);
    expect(messages.some((m) => m.includes("SHARDS.Ansu.Takeover"))).toBe(false);
    expect(messages.filter((m) => m.includes("CallCritFailReport"))).toHaveLength(1);
    expect(actor.flag.climb).toBe(2);
  });

  it("leaves a body the Ansu already holds alone, and posts no release", async () => {
    const actor = withWill(
      bearer({
        communion: { mode: "seized", rounds: null, startAt: null },
        seizure: { snapshot: {}, at: Date.now(), kind: "manual", auto: false },
        pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() },
      }),
    );
    await recordCallOutcome(actor, "criticalFailure", 3);

    expect(messages.some((m) => m.includes("SHARDS.Ansu.Takeover"))).toBe(false);
    expect(actor.rolled).toHaveLength(0);
    // The manual hold is untouched: its snapshot is still the one that returns.
    expect(actor.flag.seizure.kind).toBe("manual");
    expect(actor.flag.communion.mode).toBe("seized");
  });
});

describe("a granting Call stamps its length from the degree (0.8)", () => {
  // The bearer is attunement 4 (Discipline): F 2, S 5, CS 10 rounds.
  for (const [outcome, rounds, penalty] of [
    ["criticalSuccess", 10, 0],
    ["success", 5, 0],
    ["failure", 2, 2],
  ]) {
    it(`${outcome}: Communion for ${rounds} rounds, return penalty ${penalty}, Climb untouched`, async () => {
      const actor = bearer({ pendingCall: { id: "fresh1", dc: 28, createdAt: Date.now() } });
      await recordCallOutcome(actor, outcome, 20);

      expect(actor.flag.communion).toMatchObject({ mode: "active", rounds, returnPenalty: penalty });
      expect(actor.flag.climb).toBe(2);
      expect(actor.flag.lockout ?? null).toBeNull();
      expect(messages.some((m) => m.includes("Seizure"))).toBe(false);
    });
  }
});

describe("recording a rerolled Call (0.8 table)", () => {
  it("withdraws a critical failure's lockout and release card, then starts Communion", async () => {
    const actor = bearer({
      lockout: { until: 60, untilRest: false },
      pendingRelease: { id: "rel1", dc: 24, createdAt: Date.now() },
      lastCall: { id: "call1", dc: 28, outcome: "criticalFailure", at: Date.now() },
      rerollCall: { id: "call1", from: "criticalFailure", outcome: "success", at: Date.now() },
    });
    await recordCallOutcome(actor, "success", 30, { force: true });

    expect(actor.flag.lockout).toBeNull();
    expect(actor.flag.pendingRelease).toBeNull();
    expect(actor.flag.communion).toMatchObject({ mode: "active", rounds: 5, returnPenalty: 0 });
    expect(messages.some((m) => m.includes("CallRerollLifted"))).toBe(true);
  });

  it("restamps a running Communion when one grant is corrected into another", async () => {
    const actor = bearer({
      communion: { mode: "active", rounds: 2, startAt: null, returnPenalty: 2 },
      lastCall: { id: "call1", dc: 28, outcome: "failure", at: Date.now() },
      rerollCall: { id: "call1", from: "failure", outcome: "criticalSuccess", at: Date.now() },
    });
    await recordCallOutcome(actor, "criticalSuccess", 38, { force: true });

    expect(actor.flag.communion).toMatchObject({ mode: "active", rounds: 10, returnPenalty: 0 });
    expect(messages.some((m) => m.includes("CallRerollRestamp"))).toBe(true);
  });

  it("will not take back a granted Communion", async () => {
    const actor = bearer({
      communion: { mode: "active", rounds: 5, startAt: null, returnPenalty: 0 },
      lastCall: { id: "call1", dc: 28, outcome: "success", at: Date.now() },
      rerollCall: { id: "call1", from: "success", outcome: "criticalFailure", at: Date.now() },
    });
    await recordCallOutcome(actor, "criticalFailure", 2, { force: true });

    expect(actor.flag.communion).toMatchObject({ mode: "active", rounds: 5 });
    expect(actor.flag.lockout ?? null).toBeNull();
    expect(messages.some((m) => m.includes("RerollNoRestore"))).toBe(true);
  });
});

describe("Invoke blocks (0.8)", () => {
  const blocked = async (state, extra = {}) => {
    const { requestInvoke } = await import("../src/subsystems/ansu/mechanics/communion.mjs");
    const actor = Object.assign(bearer(state), extra);
    await requestInvoke(actor);
    return actor;
  };

  it("refuses a Fatigued bearer with a notice and posts no Call", async () => {
    const actor = await blocked({}, { hasCondition: (slug) => slug === "fatigued" });
    expect(actor.flag.pendingCall ?? null).toBeNull();
    expect(messages.some((m) => m.includes("SHARDS.Ansu.InvokeBlocked.fatigued"))).toBe(true);
  });

  it("refuses while a lockout runs", async () => {
    await blocked({ lockout: { until: 60, untilRest: false } });
    expect(messages.some((m) => m.includes("SHARDS.Ansu.InvokeBlocked.lockout"))).toBe(true);
  });

  it("does not refuse over a stale pending Call: the fresh Invoke replaces it", async () => {
    const actor = await blocked({ pendingCall: { id: "old1", dc: 28, createdAt: 1 } }, withWill({}));
    expect(actor.flag.pendingCall.id).toBe("fresh1");
    expect(messages.some((m) => m.includes("SHARDS.Ansu.InvokeBlocked"))).toBe(false);
  });

  it("refuses while the Ansu holds the body", async () => {
    await blocked({ communion: { mode: "seized", rounds: null, startAt: null } });
    expect(messages.some((m) => m.includes("SHARDS.Ansu.InvokeBlocked.seized"))).toBe(true);
  });

  it("at wrath 6 whispers the GM to call a conflict, and still posts the Call", async () => {
    const { requestInvoke } = await import("../src/subsystems/ansu/mechanics/communion.mjs");
    const actor = withWill(bearer({ wrath: 6 }));
    await requestInvoke(actor);
    expect(messages.some((m) => m.includes("SHARDS.Ansu.WrathBreakingInvoke"))).toBe(true);
    expect(actor.rolled.map((r) => r.slug)).toEqual(["athletics"]);
    expect(actor.flag.pendingCall).toMatchObject({ id: "fresh1", dc: 28 });
  });

  it("names the loyalty band and its DC move on the Call card", async () => {
    game.users.contents = [{ id: "p1", isGM: false }];
    try {
      const actor = await blocked({ loyalty: 0 }, { testUserPermission: () => true });
      expect(actor.flag.pendingCall.dc).toBe(30);
      const card = messages.find((m) => m.includes("@Check[athletics|"));
      expect(card).toContain("SHARDS.Ansu.CallLoyaltyLine SHARDS.Ansu.LoyaltyBand.hostile +2");
    } finally {
      game.users.contents = [];
    }
  });
});
