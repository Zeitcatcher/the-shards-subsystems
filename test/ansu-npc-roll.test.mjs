import { describe, it, expect, beforeEach } from "vitest";

/**
 * NPC Call and Release rolls must reach the GM alone.
 *
 * Both paths used to pass `rollMode: "gmroll"` to pf2e's `Statistic#roll`. pf2e
 * 8.5.0 has no `rollMode` parameter at all: `StatisticRollParameters` declares
 * `messageMode` (system/statistic/statistic.ts:669) and `roll` builds its check
 * context from an explicit object literal (:583-603), so a stray key is dropped
 * without a warning and `check.ts:92-94` falls back to the world default — which
 * is public. A hidden NPC bearer's Intimidation Call and every Will Release
 * landed in front of the table.
 *
 * The mechanics modules pull in the panel, which reads `foundry.applications.api`
 * at import time, so the globals go up before the dynamic import below.
 */
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "card1" },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = {
  getWhisperRecipients: () => [],
  getSpeaker: () => ({}),
  create: async () => null,
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  users: { contents: [] }, // no player owners → the NPC path
  settings: { get: () => "gm" },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, error() {} } };

const { callTheCall } = await import("../src/subsystems/ansu/mechanics/call.mjs");
const { callRelease } = await import("../src/subsystems/ansu/mechanics/release.mjs");

/** An unowned NPC bearer whose statistic roll just records what it was handed. */
function npcBearer() {
  const calls = [];
  return {
    calls,
    id: "npc1",
    uuid: "Actor.npc1",
    name: "Молчун",
    getFlag: () => ({ enabled: true, level: 3 }),
    update: async () => {},
    testUserPermission: () => false,
    getStatistic: (slug) => ({ roll: async (args) => calls.push({ slug, args }) }),
  };
}

describe("NPC rolls are whispered to the GM", () => {
  let actor;
  beforeEach(() => {
    actor = npcBearer();
  });

  it("the Call rolls Intimidation with messageMode gm", async () => {
    await callTheCall(actor, 26);
    expect(actor.calls).toHaveLength(1);
    const { slug, args } = actor.calls[0];
    expect(slug).toBe("intimidation");
    expect(args.messageMode).toBe("gm");
    expect(args.dc).toEqual({ value: 26 });
    expect(args.extraRollOptions).toContain("shards-ansu-call");
  });

  it("the Release rolls Will with messageMode gm", async () => {
    await callRelease(actor, 24, "expiry");
    expect(actor.calls).toHaveLength(1);
    const { slug, args } = actor.calls[0];
    expect(slug).toBe("will");
    expect(args.messageMode).toBe("gm");
    expect(args.dc).toEqual({ value: 24 });
    expect(args.extraRollOptions).toContain("shards-ansu-release");
  });

  it("neither passes the dead rollMode key pf2e would silently drop", async () => {
    await callTheCall(actor, 26);
    await callRelease(actor, 24, "expiry");
    expect(actor.calls).toHaveLength(2);
    for (const { args } of actor.calls) {
      expect("rollMode" in args).toBe(false);
      // "gmroll" is the pre-v14 spelling; it fails pf2e's objectHasKey check
      // against CONFIG.ChatMessage.modes and would fall through to public.
      expect(args.messageMode).not.toBe("gmroll");
    }
  });
});
