import { describe, it, expect, beforeEach } from "vitest";

/**
 * The release, 0.8 (rework step C): a Fortitude save whose every outcome ends
 * Communion; failure costs 2 x level Hit Points, critical failure 4 x level,
 * Fatigued and the release lockout. No Lingering, no seizure, no Climb.
 * Globals go up before the dynamic import, as in ansu-call-flow.test.mjs.
 */
const messages = [];

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "rel9",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
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
  time: { worldTime: 1000 },
};
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { recordReleaseOutcome, suggestedDC } = await import("../src/subsystems/ansu/mechanics/release.mjs");
const { handleExpiry } = await import("../src/subsystems/ansu/mechanics/communion.mjs");
const { healDefaults, readAnsu } = await import("../src/subsystems/ansu/state.mjs");

const FLAG = "flags.the-shards-subsystems.ansu";

/** A bearer whose flag and Hit Points survive the dot-path updates. */
function bearer(state = {}, { hp = 60 } = {}) {
  const flag = {
    enabled: true,
    level: 4,
    climb: 2,
    terminal: null,
    communion: { mode: "active", rounds: 5, startAt: null, returnPenalty: 0 },
    pendingRelease: { id: "rel1", dc: 28, reason: "", createdAt: Date.now() },
    log: [],
    ...state,
  };
  const items = [];
  items.get = () => undefined;
  const actor = {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Bearer",
    items,
    rules: [],
    conditions: [],
    rolled: [],
    system: { details: { level: { value: 5 } }, attributes: { hp: { value: hp, max: 60 } } },
    getFlag: () => flag,
    getStatistic: (slug) => ({ roll: async (args) => actor.rolled.push({ slug, args }) }),
    increaseCondition: async (slug) => actor.conditions.push(slug),
    update: async (data) => {
      for (const [path, value] of Object.entries(data)) {
        if (path === "system.attributes.hp.value") {
          actor.system.attributes.hp.value = value;
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
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
  };
  return actor;
}

const hp = (actor) => actor.system.attributes.hp.value;

beforeEach(() => {
  messages.length = 0;
});

describe("the release DC (0.8)", () => {
  it("adds the failed Call's +2", () => {
    const st = healDefaults({ level: 4, communion: { mode: "active", returnPenalty: 0 } });
    expect(suggestedDC(st)).toBe(28);
    st.communion.returnPenalty = 2;
    expect(suggestedDC(st)).toBe(30);
  });
});

describe("release outcomes (0.8)", () => {
  for (const outcome of ["criticalSuccess", "success"]) {
    it(`${outcome}: Communion ends, nothing else`, async () => {
      const actor = bearer({ communion: { mode: "active", rounds: 5, startAt: null, returnPenalty: 2 } });
      await recordReleaseOutcome(actor, outcome, 30);
      expect(actor.flag.communion.mode).toBe("none");
      expect(actor.flag.communion.returnPenalty).toBe(0);
      expect(actor.flag.pendingRelease).toBeNull();
      expect(hp(actor)).toBe(60);
      expect(actor.conditions).toEqual([]);
      expect(actor.flag.lockout ?? null).toBeNull();
      expect(actor.flag.climb).toBe(2);
      expect(actor.flag.seizure ?? null).toBeNull();
    });
  }

  it("failure: Communion ends and 2 x level Hit Points go, with a chat line", async () => {
    const actor = bearer();
    await recordReleaseOutcome(actor, "failure", 20);
    expect(actor.flag.communion.mode).toBe("none");
    expect(hp(actor)).toBe(52);
    expect(actor.conditions).toEqual([]);
    expect(actor.flag.lockout ?? null).toBeNull();
    expect(messages.some((m) => m.includes("SHARDS.Ansu.ReleaseFailReport") && m.includes(" 8 "))).toBe(true);
  });

  it("critical failure: 4 x level, Fatigued, and the Discipline lockout of an hour", async () => {
    const actor = bearer();
    await recordReleaseOutcome(actor, "criticalFailure", 5);
    expect(actor.flag.communion.mode).toBe("none");
    expect(hp(actor)).toBe(44);
    expect(actor.conditions).toEqual(["fatigued"]);
    expect(actor.flag.lockout).toEqual({ until: 4600, untilRest: false });
    expect(actor.flag.seizure ?? null).toBeNull();
    expect(messages.some((m) => m.includes("SHARDS.Ansu.ReleaseCritFailReport"))).toBe(true);
    expect(messages.some((m) => m.includes("Seizure"))).toBe(false);
  });

  it("critical failure at Trial locks out until a rest, and Hit Points stop at 1", async () => {
    const actor = bearer({ level: 2 }, { hp: 5 });
    await recordReleaseOutcome(actor, "criticalFailure", 2);
    expect(hp(actor)).toBe(1);
    expect(actor.flag.lockout).toEqual({ until: null, untilRest: true });
  });

  it("a bearer already at 0 Hit Points is not healed by the floor", async () => {
    const actor = bearer({ level: 2 }, { hp: 0 });
    await recordReleaseOutcome(actor, "failure", 2);
    expect(hp(actor)).toBe(0);
  });

  it("a stored Lingering reads as dormant", () => {
    const st = healDefaults({ level: 4, communion: { mode: "lingering", rounds: 3, startAt: 5 } });
    expect(st.communion).toMatchObject({ mode: "none", rounds: null, startAt: null });
  });
});

describe("the release after a critically failed Call (0.8 ruling)", () => {
  const afterCallCF = { communion: { mode: "none", rounds: null, startAt: null, returnPenalty: 0 }, lockout: { until: 1060, untilRest: false } };

  it("a success leaves the Call's one-minute lockout alone", async () => {
    const actor = bearer(afterCallCF);
    await recordReleaseOutcome(actor, "success", 30);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.lockout).toEqual({ until: 1060, untilRest: false });
  });

  it("a critical failure applies its costs, and the longer lockout replaces the minute", async () => {
    const actor = bearer(afterCallCF);
    await recordReleaseOutcome(actor, "criticalFailure", 2);
    expect(actor.flag.communion.mode).toBe("none");
    expect(hp(actor)).toBe(44);
    expect(actor.conditions).toEqual(["fatigued"]);
    expect(actor.flag.lockout).toEqual({ until: 4600, untilRest: false });
  });
});

describe("recording a rerolled release (0.8 table)", () => {
  const recorded = (from, to) => ({
    communion: { mode: "none", rounds: null, startAt: null, returnPenalty: 0 },
    pendingRelease: null,
    lastRelease: { id: "rel1", dc: 28, outcome: from, level: 4, at: Date.now() },
    rerollRelease: { id: "rel1", from, outcome: to, at: Date.now() },
  });

  it("a worse outcome adds only the further cost", async () => {
    const actor = bearer(recorded("failure", "criticalFailure"), { hp: 52 });
    await recordReleaseOutcome(actor, "criticalFailure", 3, { force: true });
    expect(hp(actor)).toBe(44);
    expect(actor.conditions).toEqual(["fatigued"]);
    expect(actor.flag.lockout).toEqual({ until: 4600, untilRest: false });
    expect(actor.flag.rerollRelease).toBeNull();
    expect(messages.some((m) => m.includes("SHARDS.Ansu.RerollReleaseApplied"))).toBe(true);
  });

  it("a better outcome lifts the lockout and leaves HP and Fatigued to the GM", async () => {
    const actor = bearer({ ...recorded("criticalFailure", "success"), lockout: { until: 4600, untilRest: false } }, { hp: 44 });
    await recordReleaseOutcome(actor, "success", 30, { force: true });
    expect(hp(actor)).toBe(44);
    expect(actor.flag.lockout).toBeNull();
    expect(messages.some((m) => m.includes("SHARDS.Ansu.RerollReleaseHandFix"))).toBe(true);
  });
});

describe("Communion running out (0.8)", () => {
  it("ends Communion and posts the Fortitude release at the owed DC", async () => {
    const actor = bearer({ pendingRelease: null, communion: { mode: "active", rounds: 2, startAt: null, returnPenalty: 2 } });
    await handleExpiry(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.rolled.map((r) => r.slug)).toEqual(["fortitude"]);
    expect(actor.rolled[0].args.dc).toEqual({ value: 30 });
    expect(readAnsu(actor).pendingRelease).toMatchObject({ id: "rel9", dc: 30 });
  });

  it("keeps a release card the player already opened", async () => {
    const actor = bearer();
    await handleExpiry(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.rolled).toHaveLength(0);
    expect(readAnsu(actor).pendingRelease.id).toBe("rel1");
  });

  it("never clears the open card on the way, so a roll landing mid-expiry still finds it", async () => {
    const actor = bearer();
    const update = actor.update;
    const cleared = [];
    actor.update = async (data) => {
      if (Object.hasOwn(data, `${FLAG}.pendingRelease`) && data[`${FLAG}.pendingRelease`] === null) cleared.push(data);
      return update(data);
    };
    await handleExpiry(actor);
    expect(cleared).toHaveLength(0);
    expect(actor.flag.communion.mode).toBe("none");
    expect(readAnsu(actor).pendingRelease.id).toBe("rel1");
  });
});
