import { describe, it, expect, beforeEach } from "vitest";

/**
 * A hero point spent on a Release (or a Call) used to vanish.
 *
 * pf2e 8.5.0 rerolls by deleting the rolled message and posting a NEW one built
 * from `fu.deepClone(message.flags.pf2e)` (system/check/check.ts:447): our roll
 * option and the card id survive, `context.isReroll` is set and "check:reroll"
 * is pushed onto the options (:452-454), and `context.outcome` is overwritten
 * only when the new die is the one kept (:549-554). The first roll had already
 * cleared the pending marker, so both capture paths bailed on `if (!pending)`
 * and a player who bought their way out of a Seizure stayed seized.
 *
 * Nothing here applies the reroll: the capture records it and whispers the GM.
 *
 * Foundry globals go up before the dynamic import, the same way
 * test/ansu-npc-roll.test.mjs does it.
 */
const whispers = [];
const hooks = new Map();

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "id1" },
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
  scenes: { get: () => null },
  actors: { get: () => null },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { registerReleaseHooks } = await import("../src/subsystems/ansu/mechanics/release.mjs");
const { registerCallHooks } = await import("../src/subsystems/ansu/mechanics/call.mjs");

registerReleaseHooks();
registerCallHooks();
const captures = hooks.get("createChatMessage") ?? [];

const FLAG = "flags.the-shards-subsystems.ansu";

/** A bearer whose flag survives the dot-path updates patchAnsu writes. */
function bearer(state) {
  const flag = { enabled: true, level: 4, terminal: null, ...state };
  return {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Грог",
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
  };
}

/** A rerolled check message shaped the way pf2e 8.5.0 posts one. */
function rerollMessage(actor, { type, tag, id, outcome, total = 27, extra = [] }) {
  return {
    actor,
    speaker: {},
    rolls: [{ total }],
    flags: {
      pf2e: {
        context: {
          type,
          isReroll: true,
          outcome,
          options: [tag, `${tag}-id:${id}`, "check:reroll", "check:reroll:hero-points", ...extra].sort(),
        },
      },
    },
  };
}

/** The capture hooks are fire-and-forget; let their promise chains settle. */
async function fire(message) {
  for (const fn of captures) fn(message);
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("a hero-point reroll of a resolved Release", () => {
  beforeEach(() => {
    whispers.length = 0;
  });

  it("is recorded for the GM, and moves nothing on its own", async () => {
    const actor = bearer({
      communion: { mode: "seized", rounds: null, startAt: null },
      seizure: { snapshot: {}, at: Date.now(), auto: true, thenMode: "lingering" },
      lastRelease: { id: "card1", dc: 24, outcome: "criticalFailure", at: Date.now() },
    });
    await fire(rerollMessage(actor, { type: "saving-throw", tag: "shards-ansu-release", id: "card1", outcome: "success" }));

    expect(actor.flag.rerollRelease).toMatchObject({ id: "card1", from: "criticalFailure", outcome: "success", total: 27 });
    // The state machine is untouched: undoing a resolved outcome is the GM's call.
    expect(actor.flag.communion.mode).toBe("seized");
    expect(actor.flag.seizure).not.toBe(null);
    expect(whispers).toHaveLength(1);
    expect(whispers[0]).toContain("SHARDS.Ansu.RerollReleaseNotice");
  });

  it("says nothing when the reroll kept the old die", async () => {
    const actor = bearer({
      lastRelease: { id: "card1", dc: 24, outcome: "failure", at: Date.now() },
    });
    await fire(rerollMessage(actor, { type: "saving-throw", tag: "shards-ansu-release", id: "card1", outcome: "failure" }));

    expect(actor.flag.rerollRelease ?? null).toBe(null);
    expect(whispers).toHaveLength(0);
  });

  it("ignores a reroll of somebody else's card", async () => {
    const actor = bearer({
      lastRelease: { id: "card1", dc: 24, outcome: "criticalFailure", at: Date.now() },
    });
    await fire(rerollMessage(actor, { type: "saving-throw", tag: "shards-ansu-release", id: "other", outcome: "success" }));

    expect(actor.flag.rerollRelease ?? null).toBe(null);
    expect(whispers).toHaveLength(0);
  });

  it("whispers once, however many times the message is seen", async () => {
    const actor = bearer({
      lastRelease: { id: "card1", dc: 24, outcome: "criticalFailure", at: Date.now() },
    });
    const msg = rerollMessage(actor, { type: "saving-throw", tag: "shards-ansu-release", id: "card1", outcome: "success" });
    await fire(msg);
    await fire(msg);

    expect(whispers).toHaveLength(1);
  });
});

describe("a hero-point reroll of a resolved Call", () => {
  beforeEach(() => {
    whispers.length = 0;
  });

  it("is recorded for the GM, and starts no Communion by itself", async () => {
    const actor = bearer({
      communion: { mode: "seized", rounds: null, startAt: null },
      seizure: { snapshot: {}, at: Date.now(), auto: true, thenMode: "active" },
      lastCall: { id: "call1", dc: 28, outcome: "criticalFailure", at: Date.now() },
    });
    await fire(rerollMessage(actor, { type: "skill-check", tag: "shards-ansu-call", id: "call1", outcome: "criticalSuccess" }));

    expect(actor.flag.rerollCall).toMatchObject({ id: "call1", from: "criticalFailure", outcome: "criticalSuccess" });
    expect(actor.flag.communion.mode).toBe("seized");
    expect(actor.flag.climb ?? 0).toBe(0);
    expect(whispers).toHaveLength(1);
    expect(whispers[0]).toContain("SHARDS.Ansu.RerollCallNotice");
  });

  it("leaves a rerolled check that carries none of our options alone", async () => {
    const actor = bearer({ lastCall: { id: "call1", dc: 28, outcome: "failure", at: Date.now() } });
    await fire({
      actor,
      speaker: {},
      rolls: [{ total: 30 }],
      flags: { pf2e: { context: { type: "skill-check", isReroll: true, outcome: "success", options: ["action:demoralize", "check:reroll"] } } },
    });

    expect(actor.flag.rerollCall ?? null).toBe(null);
    expect(whispers).toHaveLength(0);
  });
});
