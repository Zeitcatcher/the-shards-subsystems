import { describe, it, expect, beforeEach } from "vitest";

/**
 * What the two whispered cards actually put on the page, and what a failed Call
 * leaves behind.
 *
 * 1. The inline checks carry `roller:self`. Without it pf2e resolves a non-save
 *    check against the CLICKER's controlled tokens first and only falls back to
 *    the card's actor when nothing is selected (pf2e 8.5.0,
 *    scripts/ui/inline-roll-links.ts:140-142 and :158-164) — and for a SAVE
 *    there is no fallback at all, so a clicker with an enemy selected rolled the
 *    enemy and one with nothing selected got "No token selected". `roller`
 *    reaches that switch as `dataset.pf2Roller`
 *    (module/system/text-editor.ts:685), parsed generically by
 *    #parseInlineParams (:360-372). (item 16)
 * 2. Actor names reach the GM whispers through template literals. The name is
 *    player-editable, so it is escaped at the choke point. (item 29)
 * 3. A plain failure is the only Call outcome that never reached a sync, so out
 *    of combat pf2e never refilled the 1/round Invoke door. (item 14)
 *
 * Globals go up before the dynamic import, the same way ansu-npc-roll.test.mjs
 * does it. `escapeHTML` is the real thing here, not the identity stub.
 */
const messages = [];
const hooks = new Map();

const escapeHTML = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML,
    randomID: () => "card1",
    // An empty but VALID content file: enough for a sync to compose the marker.
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
  create: async (data) => {
    messages.push(data);
    return data;
  },
};
globalThis.game = {
  i18n: {
    localize: (k) => k,
    // Interpolate for real: the point of the escape tests is what lands in HTML.
    format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}`,
  },
  settings: { get: () => "gm" },
  users: { contents: [{ id: "p1", isGM: false }], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  combats: { contents: [] },
  scenes: { get: () => null },
  actors: { get: () => null },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { callTheCall, recordCallOutcome } = await import("../src/subsystems/ansu/mechanics/call.mjs");
const { callRelease, registerReleaseHooks } = await import("../src/subsystems/ansu/mechanics/release.mjs");

registerReleaseHooks();
const captures = hooks.get("createChatMessage") ?? [];

/**
 * A bearer a player owns, so both card paths post instead of rolling. It carries
 * just enough Foundry surface for a real syncActor pass to run against it.
 */
function bearer(name = "Грог", flag = {}) {
  const state = { enabled: true, level: 4, terminal: null, ...flag };
  const created = [];
  const items = [];
  items.get = () => undefined;
  return {
    id: "a1",
    uuid: "Actor.a1",
    name,
    created,
    items,
    rules: [],
    system: { details: { level: { value: 5 } } },
    getFlag: () => state,
    update: async () => {},
    testUserPermission: () => true,
    createEmbeddedDocuments: async (_type, docs) => created.push(...docs),
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
  };
}

describe("the inline checks roll as the card's own actor", () => {
  beforeEach(() => {
    messages.length = 0;
  });

  it("the Call card carries roller:self", async () => {
    await callTheCall(bearer(), 28);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("@Check[intimidation|");
    expect(messages[0].content).toContain("|roller:self|");
  });

  it("the Release card carries roller:self", async () => {
    await callRelease(bearer(), 26, "");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("@Check[will|");
    expect(messages[0].content).toContain("|roller:self|");
  });

  it("keeps the card id options that tie a roll back to its card", async () => {
    await callTheCall(bearer(), 28);
    await callRelease(bearer(), 26, "");
    expect(messages[0].content).toContain("options:shards-ansu-call,shards-ansu-call-id:card1");
    expect(messages[1].content).toContain("options:shards-ansu-release,shards-ansu-release-id:card1");
  });

  it("whispers owners and GMs, all of whom can update the actor", async () => {
    await callRelease(bearer(), 26, "");
    expect(messages[0].whisper).toEqual(expect.arrayContaining(["p1", "gm1"]));
  });
});

describe("actor names reach chat escaped", () => {
  // A name is player-editable text landing in a template literal.
  const NASTY = '<img src=x onerror="alert(1)">';
  /** The only thing that matters: no live tag survives the round trip. */
  const inert = (html) => !/<img/i.test(html) && html.includes("&lt;img");

  beforeEach(() => {
    messages.length = 0;
  });

  it("the Call's GM whisper escapes the name", async () => {
    await recordCallOutcome(bearer(NASTY, PENDING_CALL), "failure", 9);
    const whisper = messages.find((m) => String(m.content).includes("CallFailReport"));
    expect(whisper).toBeDefined();
    expect(inert(whisper.content)).toBe(true);
  });

  it("the Release's GM whisper escapes the name", async () => {
    const actor = bearer(NASTY, LAST_RELEASE);
    for (const fn of captures) fn(rerollMessage(actor));
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
    const whisper = messages.find((m) => String(m.content).includes("RerollReleaseNotice"));
    expect(whisper).toBeDefined();
    expect(inert(whisper.content)).toBe(true);
  });

  it("leaves an ordinary name alone", async () => {
    await recordCallOutcome(bearer("Грог", PENDING_CALL), "failure", 9);
    const whisper = messages.find((m) => String(m.content).includes("CallFailReport"));
    expect(whisper.content).toContain("Грог");
    expect(whisper.content).not.toContain("&amp;");
  });
});

describe("a failed Call and the spent Invoke door", () => {
  beforeEach(() => {
    messages.length = 0;
    game.combats.contents = [];
  });

  it("resyncs out of combat, where no round will ever refill the frequency", async () => {
    const actor = bearer("Грог", PENDING_CALL);
    await recordCallOutcome(actor, "failure", 9);
    expect(actor.created.length).toBeGreaterThan(0);
  });

  it("leaves the use spent inside a fight: the round tick is pf2e's job", async () => {
    const actor = bearer("Грог", PENDING_CALL);
    game.combats.contents = [{ started: true, combatants: [{ actor }] }];
    await recordCallOutcome(actor, "failure", 9);
    expect(actor.created).toHaveLength(0);
  });
});

const PENDING_CALL = {
  communion: { mode: "none", rounds: null, startAt: null },
  pendingCall: { id: "card1", dc: 28, createdAt: Date.now() },
  log: [],
};

const LAST_RELEASE = {
  communion: { mode: "lingering", rounds: null, startAt: null },
  lastRelease: { id: "card1", dc: 26, outcome: "failure", at: Date.now() },
  log: [],
};

/** A rerolled Will save shaped the way pf2e 8.5.0 posts one. */
const rerollMessage = (actor) => ({
  actor,
  speaker: {},
  rolls: [{ total: 29 }],
  flags: {
    pf2e: {
      context: {
        type: "saving-throw",
        isReroll: true,
        outcome: "success",
        options: ["shards-ansu-release", "shards-ansu-release-id:card1", "check:reroll"],
      },
    },
  },
});
