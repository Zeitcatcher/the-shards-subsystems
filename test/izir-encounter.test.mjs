import { describe, it, expect, beforeEach } from "vitest";

/**
 * Cooldowns and Terror both hang off the encounter, and both used to ask the wrong
 * question about it.
 *
 * `game.combat` is the encounter on the GM's VIEWED scene, so a party fighting on
 * one map while the GM had another open counted as out of combat: the Use button
 * rolled no cooldown at all (F4). Markers then outlived the fight that gave them
 * meaning, and an expired one the world never swept kept the ability greyed out.
 * Terror's "once per minute" let a long fight re-prompt the same foe while a
 * marker from an earlier fight suppressed the first save of the next one (F14).
 */
const hooks = new Map();

globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: { escapeHTML: (s) => String(s ?? ""), randomID: () => "save1", fetchJsonWithTimeout: async () => CONTENT },
};
globalThis.Hooks = {
  on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  once() {},
  callAll() {},
};
globalThis.ChatMessage = { getWhisperRecipients: () => [], getSpeaker: () => ({}), create: async () => {} };
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  actors: { get: () => null, contents: [] },
  scenes: Object.assign([], { get: () => null, contents: [] }),
  combats: Object.assign([], { contents: [] }),
  combat: null,
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.fromUuidSync = () => null;

const CONTENT = { version: 1, entries: [], tiers: [] };

const { encounterOf, inActiveCombat, isRunning, registerRechargeHooks } = await import(
  "../src/subsystems/izir/mechanics/recharge.mjs"
);

registerRechargeHooks();
const onDeleteCombat = (hooks.get("deleteCombat") ?? [])[0];
const onCreateItem = (hooks.get("createItem") ?? [])[0];
const settle = () => new Promise((r) => setTimeout(r, 0));

function actorWith(items = [], uuid = "Actor.a1") {
  const deleted = [];
  const collection = Object.assign([...items], { get: (id) => items.find((i) => i.id === id) });
  return {
    deleted,
    id: uuid.split(".").pop(),
    uuid,
    name: "Тень",
    items: collection,
    deleteEmbeddedDocuments: async (_t, ids) => {
      deleted.push(...ids);
      return [];
    },
  };
}

const marker = (id, { rolled = true, expired = false } = {}) => ({
  id,
  type: "effect",
  system: { slug: "shards-izir-recharge-wave", expired },
  isExpired: expired,
  getFlag: (_m, key) => (key === "izirRecharge" ? "wave" : key === "izirRolled" ? rolled : undefined),
  delete: async () => {},
});

const encounter = (id, actors, started = true) => ({
  id,
  started,
  combatants: actors.map((a) => ({ actor: a })),
});

const setCombats = (...list) => {
  game.combats = Object.assign([...list], { contents: list });
};

describe("finding the actor's own encounter", () => {
  beforeEach(() => setCombats());

  it("looks through every encounter, not the one the GM happens to be viewing", () => {
    const actor = actorWith();
    // game.combat stays null throughout: the GM is looking at another scene.
    setCombats(encounter("c-other", [actorWith([], "Actor.someone-else")]), encounter("c-theirs", [actor]));
    expect(game.combat).toBeNull();
    expect(encounterOf(actor)?.id).toBe("c-theirs");
    expect(inActiveCombat(actor)).toBe(true);
  });

  it("ignores an encounter that has not started", () => {
    const actor = actorWith();
    setCombats(encounter("c1", [actor], false));
    expect(encounterOf(actor)).toBeNull();
    expect(inActiveCombat(actor)).toBe(false);
  });

  it("is false with no encounters at all", () => {
    expect(inActiveCombat(actorWith())).toBe(false);
    expect(encounterOf(null)).toBeNull();
  });
});

describe("an expired marker blocks nothing", () => {
  it("counts a live marker as running and an expired one as gone", () => {
    expect(isRunning(marker("m1"))).toBe(true);
    expect(isRunning(marker("m2", { expired: true }))).toBe(false);
    expect(isRunning(null)).toBe(false);
  });
});

describe("the encounter ends", () => {
  beforeEach(() => setCombats());

  it("clears the cooldowns it rolled during the fight", async () => {
    const actor = actorWith([marker("rolled")]);
    await onDeleteCombat(encounter("c1", [actor]));
    await settle();
    expect(actor.deleted).toEqual(["rolled"]);
  });

  it("leaves a marker the GM staged by hand", async () => {
    const actor = actorWith([marker("staged", { rolled: false })]);
    await onDeleteCombat(encounter("c1", [actor]));
    await settle();
    expect(actor.deleted).toHaveLength(0);
  });
});

describe("a marker applied out of combat", () => {
  it("is left where the GM put it instead of vanishing", async () => {
    setCombats(); // nobody is fighting
    const item = marker("staged", { rolled: false });
    let deleted = false;
    item.delete = async () => {
      deleted = true;
    };
    item.parent = actorWith([item]);
    await onCreateItem(item);
    await settle();
    expect(deleted).toBe(false);
  });
});
