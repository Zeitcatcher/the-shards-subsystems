import { describe, it, expect, beforeEach } from "vitest";

/**
 * Re-sync used to be a no-op whenever the content hash matched, which is exactly
 * the case where something has gone wrong in a way the hash cannot see: 0.7.0
 * moved every selfEffect and aura uuid into the izir-internal pack, and an item
 * already on an actor still hashed the same. It now forces, and reports what it
 * actually did. (F7, F9, F10)
 */
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id1",
    fetchJsonWithTimeout: async () => CONTENT_JSON,
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = { getWhisperRecipients: () => [], getSpeaker: () => ({}), create: async () => {} };
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d) => `${k} ${JSON.stringify(d ?? {})}` },
  settings: { get: () => true },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  actors: { get: () => null, contents: [] },
  scenes: Object.assign([], { get: () => null, contents: [] }),
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.fromUuidSync = () => null;

const CONTENT_JSON = {
  version: 1,
  entries: [
    {
      id: "wave", family: "wave", rank: 1, level: 1, kind: "boon", form: "action",
      name: "Wave", description: "<p>Crash.</p>", rules: [],
      actionData: { actionType: "action", actions: 2, recharge: "1d6" },
    },
    {
      id: "plain", family: "plain", rank: 1, level: 1, kind: "boon", form: "action",
      name: "Plain", description: "<p>Nothing special.</p>", rules: [],
      actionData: { actionType: "action", actions: 1 },
    },
  ],
  tiers: [],
};

const { syncActor, buildActionSource, rechargeEffectUuid } = await import("../src/subsystems/izir/sync.mjs");
const { packUuid } = await import("../src/subsystems/izir/logic/reconcile.mjs");

const FLAG = "flags.the-shards-subsystems.izir";

/** A marked actor holding a set of already-tagged items. */
function marked(items = []) {
  const flag = {
    enabled: true, level: 1, slide: 0, terminal: null,
    suppressed: [], revealed: [], log: [], pendingTemptation: null,
  };
  const created = [];
  const updated = [];
  const deleted = [];
  // A real actor's `items` is a Collection: array-like with a `.get(id)`.
  const collection = Object.assign([...items], { get: (id) => items.find((i) => i.id === id) });
  // Mirror the composed effect's rules back as "applied" so the dropped-rule
  // diagnostic stays quiet; it has its own coverage elsewhere.
  const effect = items.find((i) => i.type === "effect");
  const rules = effect ? Array.from({ length: 99 }, () => ({ item: { id: effect.id }, ignored: false, key: "RollOption" })) : [];
  return {
    flag, created, updated, deleted,
    id: "a1",
    uuid: "Scene.s1.Token.t1.Actor.a1",
    name: "Тень",
    type: "npc",
    items: collection,
    rules,
    system: { details: { level: { value: 5 } } },
    getFlag: () => flag,
    createEmbeddedDocuments: async (_t, datas) => created.push(...datas),
    updateEmbeddedDocuments: async (_t, ups) => updated.push(...ups),
    deleteEmbeddedDocuments: async (_t, ids) => deleted.push(...ids),
    update: async () => {},
  };
}

/** An item already on the actor, tagged with the entry id and a content hash. */
const tagged = (id, entryId, contentHash) => ({
  id,
  type: entryId === "izir-immersion" ? "effect" : "action",
  system: { badge: { value: 1 } },
  getFlag: (_m, key) => (key === "izir" ? { entryId, contentHash } : undefined),
});

describe("selfEffect uuids point at the machinery pack", () => {
  it("routes a recharge ability's Use button through izir-internal", () => {
    expect(rechargeEffectUuid("wave")).toBe(packUuid("rcwave0000000000"));
    expect(rechargeEffectUuid("wave")).toContain(".izir-internal.");
  });

  it("routes a named self-effect the same way", () => {
    const src = buildActionSource({
      entryId: "herald", name: "Herald", img: "", description: "", hash: "h",
      actionData: { selfEffectId: "izirheraldruin00" },
    });
    expect(src.system.selfEffect.uuid).toBe(packUuid("izirheraldruin00"));
  });

  it("writes selfEffect: null for an ability that has none, so a stale uuid clears", () => {
    const src = buildActionSource({
      entryId: "plain", name: "Plain", img: "", description: "", hash: "h", actionData: {},
    });
    expect(src.system.selfEffect).toBeNull();
  });
});

describe("syncActor", () => {
  let actor;
  beforeEach(() => {
    actor = null;
  });

  it("does nothing and reports 0 when everything already matches", async () => {
    // Build the actor from a first sync, then sync again unchanged.
    actor = marked([]);
    const first = await syncActor(actor);
    expect(first).toBeGreaterThan(0);

    const settled = marked(
      actor.created.map((d, i) => tagged(`i${i}`, d.flags["the-shards-subsystems"].izir.entryId, d.flags["the-shards-subsystems"].izir.contentHash)),
    );
    expect(await syncActor(settled)).toBe(0);
    expect(settled.updated).toHaveLength(0);
  });

  it("rewrites every tagged item when forced, hash or no hash", async () => {
    actor = marked([]);
    await syncActor(actor);
    const settled = marked(
      actor.created.map((d, i) => tagged(`i${i}`, d.flags["the-shards-subsystems"].izir.entryId, d.flags["the-shards-subsystems"].izir.contentHash)),
    );

    const n = await syncActor(settled, { force: true });
    expect(n).toBe(settled.items.length);
    expect(settled.updated.map((u) => u._id).sort()).toEqual(settled.items.map((i) => i.id).sort());
    expect(settled.deleted).toHaveLength(0);
  });

  it("still deletes what is no longer wanted under force", async () => {
    const settled = marked([tagged("stray", "gone-entry", "h")]);
    await syncActor(settled, { force: true });
    expect(settled.deleted).toContain("stray");
    expect(settled.updated.some((u) => u._id === "stray")).toBe(false);
  });
});
