import { describe, it, expect, beforeEach } from "vitest";

/**
 * Izir's Terror is Frightful Presence: once per encounter, not once per wall-clock
 * minute. The old minute-long immunity let a long fight re-prompt the same foe
 * over and over, while a marker left over from an earlier fight silently ate the
 * first save of the next one. The immunity is now stamped with the encounter it
 * belongs to, and a copy stamped with any other one is deleted on sight rather
 * than trusted to a pf2e automation setting the world may have switched off. (F14)
 */
const hooks = new Map();
const messages = [];

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "save1", fetchJsonWithTimeout: async () => CONTENT },
};
globalThis.Hooks = {
  on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  once() {},
  callAll() {},
};
globalThis.ChatMessage = {
  getWhisperRecipients: () => [],
  getSpeaker: () => ({}),
  create: async (data) => messages.push(data.content),
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => 20 },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  actors: { get: () => null, contents: [] },
  scenes: Object.assign([], { get: () => null, contents: [] }),
  combats: Object.assign([], { contents: [] }),
  combat: null,
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const CONTENT = { version: 1, entries: [], tiers: [] };
const MODULE_ID = "the-shards-subsystems";
const IMMUNITY_SLUG = "shards-izir-terror-immune";

let bearer;
globalThis.fromUuidSync = () => bearer;

const { registerTerrorHooks } = await import("../src/subsystems/izir/mechanics/terror.mjs");
registerTerrorHooks();
const onCreateItem = (hooks.get("createItem") ?? [])[0];
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The Nameless whose aura this is. */
function makeBearer() {
  const flag = { enabled: true, level: 4, slide: 0, terminal: null, suppressed: [], revealed: [], log: [] };
  return { id: "b1", uuid: "Actor.b1", name: "Тень", documentName: "Actor", getFlag: () => flag };
}

/** A foe who just stepped into the aura. */
function target(items = []) {
  const created = [];
  const deleted = [];
  const collection = Object.assign([...items], { get: (id) => items.find((i) => i.id === id) });
  return {
    created,
    deleted,
    id: "t1",
    uuid: "Token.t1.Actor.t1",
    name: "Наёмник",
    items: collection,
    testUserPermission: () => false,
    createEmbeddedDocuments: async (_t, datas) => {
      created.push(...datas);
      return [];
    },
    deleteEmbeddedDocuments: async (_t, ids) => {
      deleted.push(...ids);
      return [];
    },
  };
}

/** An immunity effect already on the target, stamped with an encounter. */
const immunity = (id, combatId) => ({
  id,
  type: "effect",
  system: { slug: IMMUNITY_SLUG, expired: false },
  isExpired: false,
  getFlag: (_m, key) =>
    key === "terrorImmuneFrom" ? "Actor.b1" : key === "terrorImmuneCombat" ? combatId : undefined,
});

/** The rule-free tracker effect the Aura drops on whoever enters. */
const auraMarker = () => ({
  type: "effect",
  system: { slug: "shards-izir-pack-izirterroraura00" },
  flags: { pf2e: { aura: { origin: "Actor.b1" } } },
  parent: null,
});

const fight = (id, actors) => ({ id, started: true, combatants: actors.map((a) => ({ actor: a })) });
const setCombats = (...list) => {
  game.combats = Object.assign([...list], { contents: list });
};

const enter = async (t) => {
  const m = auraMarker();
  m.parent = t;
  await onCreateItem(m);
  await settle();
};

describe("Terror prompts once per encounter", () => {
  beforeEach(() => {
    bearer = makeBearer();
    messages.length = 0;
    setCombats();
  });

  it("prompts on the first entry and stamps the immunity with that encounter", async () => {
    const t = target();
    setCombats(fight("c1", [t, bearer]));
    await enter(t);

    expect(messages).toHaveLength(1);
    expect(t.created).toHaveLength(1);
    const eff = t.created[0];
    expect(eff.system.duration).toEqual({ value: -1, unit: "encounter", sustained: false, expiry: null });
    expect(eff.flags[MODULE_ID].terrorImmuneCombat).toBe("c1");
  });

  it("stays quiet when the same foe steps back in during the same fight", async () => {
    const t = target([immunity("i1", "c1")]);
    setCombats(fight("c1", [t, bearer]));
    await enter(t);

    expect(messages).toHaveLength(0);
    expect(t.created).toHaveLength(0);
    expect(t.deleted).toHaveLength(0);
  });

  it("clears a marker from an earlier fight and prompts again in the new one", async () => {
    const t = target([immunity("old", "c1")]);
    setCombats(fight("c2", [t, bearer]));
    await enter(t);

    expect(t.deleted).toEqual(["old"]);
    expect(messages).toHaveLength(1);
    expect(t.created[0].flags[MODULE_ID].terrorImmuneCombat).toBe("c2");
  });

  it("falls back to the wall clock when nobody is in an encounter", async () => {
    const t = target();
    await enter(t);

    expect(messages).toHaveLength(1);
    expect(t.created[0].system.duration).toEqual({
      value: 1, unit: "minutes", sustained: false, expiry: "turn-start",
    });
    expect(t.created[0].flags[MODULE_ID].terrorImmuneCombat).toBeNull();
  });

  it("carries a per-save id so a reroll can be told apart from a fresh save", async () => {
    const t = target();
    setCombats(fight("c1", [t, bearer]));
    await enter(t);
    expect(messages[0]).toContain("shards-izir-terror-id:save1");
  });
});
