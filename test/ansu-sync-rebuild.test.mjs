import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { syncActor } from "../src/subsystems/ansu/sync.mjs";
import { clearContentCache } from "../src/subsystems/ansu/content.mjs";
import { COMMUNION_ENTRY_ID } from "../src/subsystems/ansu/logic/reconcile.mjs";

/**
 * The expiry rebuild, end to end.
 *
 * With pf2e's removeExpiredEffects on, the expiring Communion effect is DELETED
 * (pf2e's TempHP.onDelete zeroes the pool on the way out) and this sync creates
 * it again — which used to run TempHP.onCreate a second time and hand a level 9
 * bearer 27 fresh temporary Hit Points at the exact moment the buff was running
 * out. These tests pin the item source the sync actually writes.
 */

const CONTENT = JSON.parse(
  readFileSync(new URL("../data/ansu/content.json", import.meta.url), "utf8"),
);

/** An items collection that behaves enough like Foundry's for the sync. */
function itemsOf(list) {
  const coll = list;
  coll.get = (id) => coll.find((i) => i.id === id);
  return coll;
}

/** An attuned bearer whose Communion effect pf2e has just deleted. */
function bearer({ level = 5, mode = "lingering", temp = 0, tempsource } = {}) {
  const hp = { value: 60, max: 60, temp, ...(tempsource === undefined ? {} : { tempsource }) };
  const actor = {
    id: "a1",
    uuid: "Actor.a1",
    name: "Грог",
    created: [],
    updates: [],
    system: { details: { level: { value: 9 } }, attributes: { hp } },
    _source: { system: { attributes: { hp: { ...hp } } } },
    items: itemsOf([]),
    getFlag: () => ({
      enabled: true,
      level,
      communion: { mode, rounds: null, startAt: null },
    }),
    update: async (data) => actor.updates.push(data),
    async createEmbeddedDocuments(_type, sources) {
      const docs = sources.map((src, n) => ({
        id: `new${actor.items.length + n}`,
        ...src,
        getFlag: (_m, _s) => src.flags?.["the-shards-subsystems"]?.ansu,
      }));
      actor.created.push(...sources);
      actor.items.push(...docs);
      return docs;
    },
    updateEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => [],
  };
  // What pf2e reports as applied, so the sync's dropped-rule diagnostic stays quiet.
  Object.defineProperty(actor, "rules", {
    get: () =>
      actor.items.flatMap((i) =>
        (i.system?.rules ?? []).map((r) => ({ key: r.key, item: { id: i.id }, ignored: false })),
      ),
  });
  return actor;
}

/** The TempHP rule on the Communion source this sync wrote, if it wrote one. */
function tempRuleWritten(actor) {
  const src = actor.created.find(
    (s) => s.flags?.["the-shards-subsystems"]?.ansu?.entryId === COMMUNION_ENTRY_ID,
  );
  return src?.system?.rules?.find((r) => r.key === "TempHP") ?? null;
}

const hpWrites = (actor) => actor.updates.filter((u) => "system.attributes.hp.temp" in u);

beforeEach(() => {
  clearContentCache();
  globalThis.foundry = { utils: { fetchJsonWithTimeout: async () => CONTENT } };
  globalThis.game = {
    settings: { get: () => undefined }, // every dial falls back to its default
    i18n: { localize: (k) => k, format: (k) => k },
    time: { worldTime: 0 },
    combats: { contents: [] },
  };
});
afterEach(() => {
  clearContentCache();
  delete globalThis.foundry;
  delete globalThis.game;
});

describe("syncActor — ordinary create", () => {
  it("grants the tier's pool the first time the effect is built", async () => {
    const actor = bearer({ mode: "active" });
    await syncActor(actor);
    const rule = tempRuleWritten(actor);
    expect(rule.value).toBe(15); // 3 × attunement 5
    expect(rule.events).toBeUndefined(); // pf2e's default: onCreate true
    expect(hpWrites(actor)).toHaveLength(0);
  });
});

describe("syncActor — expiry rebuild", () => {
  it("re-creates the effect without its create-time grant", async () => {
    const actor = bearer();
    await syncActor(actor, { rebuild: true, carriedTemp: 8 });
    const rule = tempRuleWritten(actor);
    // the rule stays on the item so pf2e's onDelete still clears the pool later
    expect(rule.value).toBe(15);
    expect(rule.events).toEqual({ onCreate: false, onTurnStart: false });
  });

  it("carries a partly spent pool across the transition, pointed at the new item", async () => {
    const actor = bearer(); // pf2e already zeroed the pool on delete
    await syncActor(actor, { rebuild: true, carriedTemp: 8 });
    const writes = hpWrites(actor);
    expect(writes).toHaveLength(1);
    expect(writes[0]["system.attributes.hp.temp"]).toBe(8);
    const rebuilt = actor.items.find(
      (i) => i.flags?.["the-shards-subsystems"]?.ansu?.entryId === COMMUNION_ENTRY_ID,
    );
    expect(writes[0]["system.attributes.hp.tempsource"]).toBe(rebuilt.id);
  });

  it("leaves a fully spent pool spent", async () => {
    const actor = bearer();
    await syncActor(actor, { rebuild: true, carriedTemp: 0 });
    expect(tempRuleWritten(actor).events.onCreate).toBe(false);
    expect(hpWrites(actor)).toHaveLength(0);
  });

  it("never stacks: a bigger pool from another source survives untouched", async () => {
    const actor = bearer({ temp: 20, tempsource: "someOtherEffect" });
    await syncActor(actor, { rebuild: true, carriedTemp: 8 });
    expect(hpWrites(actor)).toHaveLength(0);
  });
});
