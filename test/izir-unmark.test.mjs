import { describe, it, expect, beforeEach } from "vitest";

/**
 * Removing the mark used to leave a transformed actor wearing Izir's face.
 *
 * The captured original portrait and token art live inside the flag namespace
 * that Unmark deletes. Once `deleteSubsystemFlag` actually started working
 * (0.6.6), that made the loss permanent: no revert, and no record of what the art
 * had been. Unmark now puts the original art back BEFORE the flag goes. (F5)
 */
const updates = [];
const unset = [];
let confirmAnswer = true;

class FakeApp {
  render() {
    return this;
  }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: FakeApp,
      HandlebarsApplicationMixin: (base) => base,
      DialogV2: { confirm: async () => confirmAnswer },
    },
  },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id1",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = { getWhisperRecipients: () => [], getSpeaker: () => ({}), create: async () => {} };
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  actors: { get: () => null, contents: [] },
  // A real `game.scenes` is an iterable Collection; art.mjs walks it.
  scenes: Object.assign([], { get: () => null, contents: [] }),
  modules: { get: () => ({}) },
};
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const FLAG = "flags.the-shards-subsystems.izir";
let subject = null;
globalThis.fromUuidSync = () => subject;

const { IzirPanel } = await import("../src/subsystems/izir/apps/izir-panel.mjs");

/** A marked actor with swapped art and the originals captured. */
function marked() {
  const flag = {
    enabled: true,
    level: 7,
    slide: 0,
    terminal: null,
    suppressed: [],
    revealed: [],
    log: [],
    pendingTemptation: null,
    art: {
      thresholds: { 4: { portrait: "", token: "" }, 7: { portrait: "swap.webp", token: "swap-t.webp" }, 10: { portrait: "", token: "" } },
      original: { portrait: "hero.webp", token: "hero-token.webp" },
      applied: "7",
    },
  };
  return {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Мор'Кай",
    type: "npc",
    isToken: false,
    img: "swap.webp",
    items: [],
    system: { details: { level: { value: 8 } }, traits: { value: ["shards-nameless"] } },
    prototypeToken: { texture: { src: "swap-t.webp" } },
    getFlag: () => flag,
    unsetFlag: async () => unset.push("izir"),
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
    update: async (data) => {
      updates.push(data);
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
  };
}

const unmark = IzirPanel.DEFAULT_OPTIONS.actions.unmark;
const click = (actor) => unmark.call({ _actorUuid: actor.uuid, render() {} }, null, { dataset: { actor: actor.uuid } });

describe("removing the mark", () => {
  beforeEach(() => {
    updates.length = 0;
    unset.length = 0;
    confirmAnswer = true;
  });

  it("restores the original portrait and token before deleting the flag", async () => {
    subject = marked();
    await click(subject);

    const artUpdate = updates.find((u) => "img" in u);
    expect(artUpdate).toEqual({ img: "hero.webp", "prototypeToken.texture.src": "hero-token.webp" });
    expect(unset).toEqual(["izir"]);

    // Order matters: the originals are read out of the flag, so the revert has to
    // land while the flag is still there.
    expect(updates.indexOf(artUpdate)).toBeLessThan(updates.length - 1);
  });

  it("does nothing when the GM cancels the confirmation", async () => {
    confirmAnswer = false;
    subject = marked();
    await click(subject);
    expect(updates).toHaveLength(0);
    expect(unset).toHaveLength(0);
  });

  it("is a no-op on art for an actor that was never swapped", async () => {
    subject = marked();
    subject.flag.art.original = null;
    await click(subject);
    expect(updates.some((u) => "img" in u)).toBe(false);
    expect(unset).toEqual(["izir"]);
  });
});
