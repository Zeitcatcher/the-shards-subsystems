import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The conflict of will and the takeovers, 0.8 (rework step D, spec section 6
 * and the rulings after step C). Globals go up before the dynamic import, as in
 * ansu-release-rework.test.mjs.
 */
const DEEDS = JSON.parse(readFileSync(new URL("../data/ansu/deeds.json", import.meta.url), "utf8"));
const messages = [];
const hooks = {};
const users = { contents: [], activeGM: { id: "gm1" } };

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id9",
    fetchJsonWithTimeout: async (path) =>
      path.endsWith("deeds.json") ? DEEDS : { version: 1, entries: [], tiers: [] },
  },
};
globalThis.Hooks = {
  on(name, fn) {
    (hooks[name] ??= []).push(fn);
  },
  once() {},
  callAll() {},
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [{ id: "gm1" }],
  getSpeaker: () => ({}),
  create: async (data) => messages.push({ content: data.content, whisper: data.whisper ?? null }),
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}` },
  settings: { get: () => "gm" },
  users,
  user: { id: "gm1", isGM: true },
  combats: { contents: [] },
  scenes: { get: () => null },
  actors: { get: () => null },
  time: { worldTime: 1000 },
};
globalThis.CONFIG = { time: { roundTime: 6 } };
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { startConflict, recordConflictOutcome, recordConflictReroll, registerConflictHooks } = await import(
  "../src/subsystems/ansu/mechanics/conflict.mjs"
);
const { startSeizure, returnFromSeizure, letAnsuIn, onSeizureTurnEnd, onSeizureCombatEnd, registerSeizureHooks } =
  await import("../src/subsystems/ansu/mechanics/seizure.mjs");
const { durationRoundsFor, conflictDC } = await import("../src/subsystems/ansu/logic/model.mjs");

registerConflictHooks();
registerSeizureHooks();

const FLAG = "flags.the-shards-subsystems.ansu";

/** A level-5 NPC bearer at attunement 4 whose flag survives the dot-path updates. */
function bearer(state = {}, { conditions = [] } = {}) {
  const flag = {
    enabled: true,
    level: 4,
    loyalty: 5,
    wrath: 0,
    terminal: null,
    communion: { mode: "none", rounds: null, startAt: null, returnPenalty: 0 },
    log: [],
    ...state,
  };
  const items = [];
  items.get = () => undefined;
  items.find = () => undefined;
  const actor = {
    flag,
    id: "a1",
    uuid: "Actor.a1",
    name: "Bearer",
    items,
    rules: [],
    conditions: [...conditions],
    rolled: [],
    system: { details: { level: { value: 5 } }, attributes: { hp: { value: 60, max: 60 } } },
    getFlag: () => flag,
    hasCondition: (slug) => actor.conditions.includes(slug),
    getStatistic: (slug) => ({ roll: async (args) => actor.rolled.push({ slug, args }) }),
    increaseCondition: async (slug) => actor.conditions.push(slug),
    testUserPermission: () => true,
    update: async (data) => {
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
    createEmbeddedDocuments: async () => {},
    updateEmbeddedDocuments: async () => {},
    deleteEmbeddedDocuments: async () => {},
  };
  return actor;
}

const deeds = (actor) => actor.flag.log.filter((e) => e.type === "deed").map((e) => e.data.deed);
const open = (stage, extra = {}) => ({ pendingConflict: { id: "c1", dc: 22, stage, want: "finish him", severity: "serious", createdAt: 1, ...extra } });

beforeEach(() => {
  messages.length = 0;
  users.contents = [];
});

describe("opening a conflict of will", () => {
  it("whispers the GM the want and DC, and gives a player bearer Persuade and Will at conflictDC", async () => {
    users.contents = [{ id: "p1", isGM: false }];
    const actor = bearer({ wrath: 3 });
    await startConflict(actor, { want: "finish him", severity: "serious" });
    const dc = conflictDC(5, "serious", 3);
    expect(dc).toBe(20 + 2 + 2);
    expect(actor.flag.pendingConflict).toMatchObject({ dc, stage: "persuade", severity: "serious" });
    const gm = messages.find((m) => m.content.includes("ConflictGMWant"));
    expect(gm.whisper).toEqual(["gm1"]);
    expect(gm.content).toContain("finish him");
    const card = messages.find((m) => m.content.includes("ConflictCardTitle"));
    expect(card.whisper).toEqual(["p1", "gm1"]);
    expect(card.content).not.toContain("finish him");
    for (const stat of ["diplomacy", "intimidation", "will"]) expect(card.content).toContain(`@Check[${stat}|dc:${dc}|`);
    expect(card.content).toContain("shards-ansu-conflict-id:id9");
  });

  it("sends an NPC bearer straight to the Will save, rolled by the GM", async () => {
    const actor = bearer();
    await startConflict(actor, { want: "x", severity: "minor" });
    expect(actor.flag.pendingConflict.stage).toBe("will");
    expect(actor.rolled).toEqual([expect.objectContaining({ slug: "will" })]);
    expect(actor.rolled[0].args.dc).toEqual({ value: 20 });
  });

  it("is refused while the Ansu holds the body", async () => {
    const actor = bearer({ communion: { mode: "seized" }, seizure: { kind: "manual", snapshot: {} } });
    await startConflict(actor, { want: "x" });
    expect(actor.flag.pendingConflict ?? null).toBeNull();
  });
});

describe("the outcomes", () => {
  it("Persuade success: resolved, +1 loyalty through `argument`", async () => {
    const actor = bearer(open("persuade"));
    await recordConflictOutcome(actor, "success", 25);
    expect(actor.flag.pendingConflict).toBeNull();
    expect(actor.flag.loyalty).toBe(6);
    expect(deeds(actor)).toEqual(["argument"]);
  });

  it("Persuade failure: the Will save follows at the same DC", async () => {
    const actor = bearer(open("persuade"));
    await recordConflictOutcome(actor, "failure", 10);
    expect(actor.flag.pendingConflict).toMatchObject({ id: "c1", stage: "will", dc: 22 });
    expect(actor.rolled.map((r) => r.slug)).toEqual(["will"]);
    expect(deeds(actor)).toEqual([]);
  });

  it("Will success: holds, +1 Wrath through `forced-back`", async () => {
    const actor = bearer(open("will"));
    await recordConflictOutcome(actor, "success");
    expect(actor.flag.wrath).toBe(1);
    expect(actor.flag.communion.mode).toBe("none");
  });

  it("Will failure, calm: a forced takeover that returns at the next turn end, then `vented-1`", async () => {
    const actor = bearer({ ...open("will"), wrath: 2, communion: { mode: "active", rounds: 5, startAt: null, returnPenalty: 2 } });
    await recordConflictOutcome(actor, "failure");
    expect(actor.flag.communion.mode).toBe("seized");
    expect(actor.flag.seizure).toMatchObject({ kind: "forced", turnsLeft: 1, deed: "vented-1", dc: 22, conflictId: "c1" });
    expect(messages.some((m) => m.content.includes("TakeoverForced "))).toBe(true);

    await onSeizureTurnEnd(actor, { rolledOver: false });
    // The running Communion resumes (no release save), with its +2 still owed.
    expect(actor.flag.seizure).toBeNull();
    expect(actor.flag.communion).toMatchObject({ mode: "active", rounds: 5, returnPenalty: 2, startAt: 1006 });
    expect(actor.rolled).toHaveLength(0);
    expect(actor.flag.wrath).toBe(1);
    expect(deeds(actor)).toEqual(["vented-1"]);
  });

  it("Will failure, angry: returns one turn end later, then `vented-2`", async () => {
    const actor = bearer({ ...open("will"), wrath: 4 });
    await recordConflictOutcome(actor, "failure");
    expect(actor.flag.seizure.turnsLeft).toBe(2);
    await onSeizureTurnEnd(actor);
    expect(actor.flag.communion.mode).toBe("seized");
    await onSeizureTurnEnd(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.wrath).toBe(2);
  });

  it("Will critical failure at breaking point: berserk plus `conflict-cf`; a won check ends it with `berserk-end`", async () => {
    const actor = bearer({ ...open("will"), wrath: 6, loyalty: 4 });
    await recordConflictOutcome(actor, "criticalFailure");
    expect(actor.flag.seizure).toMatchObject({ kind: "berserk", deed: "berserk-end", dc: 22 });
    expect(actor.flag.loyalty).toBe(3);
    expect(messages.find((m) => m.content.includes("TakeoverBerserk")).whisper).toBeNull(); // public

    await onSeizureTurnEnd(actor);
    expect(actor.flag.pendingConflict).toMatchObject({ stage: "berserk", dc: 22 });
    expect(actor.rolled.map((r) => r.slug)).toEqual(["will"]);
    await recordConflictOutcome(actor, "failure");
    expect(actor.flag.communion.mode).toBe("seized");

    await onSeizureTurnEnd(actor);
    await recordConflictOutcome(actor, "success");
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.seizure).toBeNull();
    expect(actor.flag.wrath).toBe(2);
    expect(actor.flag.loyalty).toBe(2);
    expect(deeds(actor)).toEqual(["conflict-cf", "berserk-end"]);
    expect(actor.rolled.filter((r) => r.slug === "fortitude")).toHaveLength(0); // no release save
  });
});

describe("berserk endings", () => {
  const berserk = () =>
    bearer({
      wrath: 6,
      communion: { mode: "seized", rounds: null, startAt: null },
      seizure: { kind: "berserk", snapshot: { level: 4, communion: { mode: "active", rounds: 3 } }, deed: "berserk-end", dc: 22 },
    });

  it("ends when the bearer falls unconscious, with no Communion left", async () => {
    const actor = berserk();
    for (const fn of hooks.createItem ?? []) fn({ type: "condition", slug: "unconscious", actor });
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(actor.flag.communion.mode).toBe("none");
    expect(deeds(actor)).toEqual(["berserk-end"]);
  });

  it("an unconscious bearer at a turn end gets no check: the takeover ends", async () => {
    const actor = berserk();
    actor.conditions.push("unconscious");
    await onSeizureTurnEnd(actor);
    expect(actor.rolled).toHaveLength(0);
    expect(actor.flag.seizure).toBeNull();
  });

  it("survives a combat ending; only the GM's hand-back ends it out of combat", async () => {
    const actor = berserk();
    await onSeizureCombatEnd(actor);
    expect(actor.flag.communion.mode).toBe("seized");
    await returnFromSeizure(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.flag.wrath).toBe(2);
  });
});

describe("letting the Ansu in", () => {
  it("is refused unless calm, unused today and below level 10", async () => {
    for (const st of [{ wrath: 3 }, { consentUsed: true }, { level: 10, terminal: "subjugated" }]) {
      const actor = bearer(st);
      expect(await letAnsuIn(actor)).toBe(false);
      expect(actor.flag.seizure ?? null).toBeNull();
    }
  });

  it("runs the success length, sets consentUsed, then ends with the release card", async () => {
    const actor = bearer({ wrath: 1 });
    expect(await letAnsuIn(actor)).toBe(true);
    expect(actor.flag.consentUsed).toBe(true);
    expect(actor.flag.seizure).toMatchObject({ kind: "agreed", turnsLeft: durationRoundsFor(4, 2) });
    for (let i = 0; i < 5; i += 1) await onSeizureTurnEnd(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.rolled.map((r) => r.slug)).toEqual(["fortitude"]);
    expect(actor.flag.pendingRelease).toMatchObject({ dc: 28 });
  });

  it("hands back at once when the combat ends", async () => {
    const actor = bearer({ wrath: 0 });
    await letAnsuIn(actor);
    await onSeizureCombatEnd(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(actor.rolled.map((r) => r.slug)).toEqual(["fortitude"]);
  });
});

describe("a manual GM hold", () => {
  it("never returns on its own and comes back whole", async () => {
    const actor = bearer({ communion: { mode: "active", rounds: 3, startAt: null, returnPenalty: 0 } });
    await startSeizure(actor);
    expect(actor.flag.seizure.kind).toBe("manual");
    await onSeizureTurnEnd(actor);
    await onSeizureCombatEnd(actor);
    expect(actor.flag.communion.mode).toBe("seized");
    await returnFromSeizure(actor);
    expect(actor.flag.communion).toMatchObject({ mode: "active", rounds: 3 });
    expect(deeds(actor)).toEqual([]);
  });
});

describe("capture and reroll", () => {
  const fire = async (message) => {
    for (const fn of hooks.createChatMessage ?? []) fn(message);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const msg = (actor, type, outcome, extra = []) => ({
    actor,
    flags: { pf2e: { context: { type, outcome, options: ["shards-ansu-conflict", "shards-ansu-conflict-id:c1", ...extra] } } },
    rolls: [{ total: 20 }],
  });

  it("a tagged persuasion check resolves the persuade stage", async () => {
    const actor = bearer(open("persuade"));
    await fire(msg(actor, "skill-check", "criticalSuccess"));
    expect(actor.flag.pendingConflict).toBeNull();
    expect(deeds(actor)).toEqual(["argument"]);
  });

  it("a tagged Will save resolves the Will stage; a stray persuasion after a failed one is ignored", async () => {
    const actor = bearer(open("will"));
    await fire(msg(actor, "skill-check", "success"));
    expect(actor.flag.pendingConflict).toMatchObject({ stage: "will" });
    await fire(msg(actor, "saving-throw", "success"));
    expect(deeds(actor)).toEqual(["forced-back"]);
  });

  it("a hero-point reroll from failure to success, once recorded, hands the body back with no vented deed", async () => {
    const actor = bearer({ ...open("will"), wrath: 0 });
    await recordConflictOutcome(actor, "failure");
    expect(actor.flag.communion.mode).toBe("seized");
    await fire(msg(actor, "saving-throw", "success", ["check:reroll"]));
    expect(actor.flag.rerollConflict).toMatchObject({ id: "c1", stage: "will", from: "failure", outcome: "success" });
    expect(actor.flag.communion.mode).toBe("seized"); // nothing moves until the GM records it
    await recordConflictReroll(actor);
    expect(actor.flag.communion.mode).toBe("none");
    expect(deeds(actor)).toEqual(["forced-back"]);
    expect(actor.flag.rerollConflict).toBeNull();
  });
});
