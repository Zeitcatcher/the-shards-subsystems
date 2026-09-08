import { describe, it, expect, beforeEach } from "vitest";

/**
 * Three ways the art lifecycle went wrong, all from state that outlived its
 * meaning: a capture kept after a revert stamped the FIRST portrait back over new
 * base art two swaps later; a manual revert for a social scene was undone by the
 * next failed save; and a threshold row cleared while applied left the actor
 * wearing art the row no longer held. (F25)
 */
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "id1" },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => true },
  scenes: Object.assign([], { get: () => null, contents: [] }),
  actors: { get: () => null, contents: [] },
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { applyThresholdArt, revertArt, maybeSwapForLevel } = await import("../src/subsystems/izir/art.mjs");

const FLAG = "flags.the-shards-subsystems.izir";

function nameless(overrides = {}) {
  const flag = {
    enabled: true,
    level: 1,
    slide: 0,
    terminal: null,
    suppressed: [],
    revealed: [],
    log: [],
    art: {
      thresholds: { 4: { portrait: "grip.webp", token: "" }, 7: { portrait: "", token: "" }, 10: { portrait: "", token: "" } },
      original: null,
      applied: null,
      hold: false,
      ...overrides,
    },
  };
  const actor = {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Тень",
    isToken: false,
    img: "hero.webp",
    prototypeToken: { texture: { src: "hero-token.webp" } },
    getFlag: () => flag,
    update: async (data) => {
      for (const [path, value] of Object.entries(data)) {
        if (path === "img") {
          actor.img = value;
          continue;
        }
        if (path === "prototypeToken.texture.src") {
          actor.prototypeToken.texture.src = value;
          continue;
        }
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

describe("the art lifecycle", () => {
  let actor;
  beforeEach(() => {
    actor = nameless();
  });

  it("releases the capture on revert, so the next swap captures the art that is there now", async () => {
    await applyThresholdArt(actor, "4");
    expect(actor.img).toBe("grip.webp");
    expect(actor.flag.art.original.portrait).toBe("hero.webp");

    await revertArt(actor);
    expect(actor.img).toBe("hero.webp");
    expect(actor.flag.art.original).toBeNull();

    // The GM now sets different base art and the character sinks again.
    actor.img = "hero-v2.webp";
    await applyThresholdArt(actor, "4");
    await revertArt(actor);
    // The SECOND base art comes back, not the first.
    expect(actor.img).toBe("hero-v2.webp");
  });

  it("holds automatic swaps after a manual revert", async () => {
    await applyThresholdArt(actor, "4");
    await revertArt(actor, { hold: true });
    expect(actor.flag.art.hold).toBe(true);

    // The next failed save pushes them deeper; the horror art stays off.
    await maybeSwapForLevel(actor, 6);
    expect(actor.img).toBe("hero.webp");
    expect(actor.flag.art.applied).toBeNull();
  });

  it("lifts the hold when the GM applies art by hand", async () => {
    await revertArt(actor, { hold: true });
    await applyThresholdArt(actor, "4");
    expect(actor.flag.art.hold).toBe(false);
    expect(actor.img).toBe("grip.webp");

    await maybeSwapForLevel(actor, 1);
    expect(actor.img).toBe("hero.webp"); // back below every threshold
  });

  it("swaps automatically when nothing is holding it", async () => {
    await maybeSwapForLevel(actor, 5);
    expect(actor.img).toBe("grip.webp");
    expect(actor.flag.art.applied).toBe("4");
  });
});
