import { describe, it, expect, beforeEach } from "vitest";

/**
 * The Tenth Step is the last rung, not a shortcut.
 *
 * `triggerFork` used to guard on a terminal alone, so the panel button, the two
 * ladder chips and any macro could hand a level 2 bearer the Mastery / Taken
 * dialog and lock the tracker on the spot. The gate now lives inside
 * `triggerFork` itself, which is where every caller passes.
 *
 * Foundry globals go up before the dynamic import: the module chain reads them
 * while it loads, the same way test/ansu-npc-roll.test.mjs does it.
 */
const opened = [];
const warned = [];

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (base) => base,
      DialogV2: {
        wait: async (config) => {
          opened.push(config);
          return null; // the GM closes it; nothing is applied either way
        },
      },
    },
  },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "id1" },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = { getWhisperRecipients: () => [], getSpeaker: () => ({}), create: async () => null };
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => 2 },
  users: { contents: [] },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn: (m) => warned.push(m), info() {}, error() {} } };

const { triggerFork } = await import("../src/subsystems/ansu/transform.mjs");

/** A bearer whose flag reads back whatever level the test asked for. */
function bearer(state) {
  const updates = [];
  return {
    updates,
    id: "a1",
    uuid: "Actor.a1",
    name: "Грог",
    getFlag: () => ({ enabled: true, terminal: null, ...state }),
    update: async (data) => updates.push(data),
  };
}

describe("triggerFork is gated at attunement 9", () => {
  beforeEach(() => {
    opened.length = 0;
    warned.length = 0;
  });

  it("refuses below the ninth rung, without opening the dialog", async () => {
    for (const level of [0, 2, 8]) {
      const actor = bearer({ level });
      expect(await triggerFork(actor)).toBe(false);
      expect(opened).toHaveLength(0);
      expect(actor.updates).toHaveLength(0);
    }
    expect(warned).toEqual(["SHARDS.Ansu.TenthLocked", "SHARDS.Ansu.TenthLocked", "SHARDS.Ansu.TenthLocked"]);
  });

  it("opens the dialog at attunement 9", async () => {
    const actor = bearer({ level: 9 });
    expect(await triggerFork(actor)).toBe(false); // the GM cancelled
    expect(opened).toHaveLength(1);
    expect(warned).toHaveLength(0);
  });

  it("stays shut at a terminal, and says nothing: that fate is already chosen", async () => {
    const actor = bearer({ level: 10, terminal: "subjugated" });
    expect(await triggerFork(actor)).toBe(false);
    expect(opened).toHaveLength(0);
    expect(warned).toHaveLength(0);
  });
});
