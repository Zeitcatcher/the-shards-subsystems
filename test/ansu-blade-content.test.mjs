import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
/**
 * Rework step F (spec section 8 and the step E rulings): the bound blade's
 * number tokens, the per-Communion recall count, Blade's Return on a dormant
 * sheet, the DC-hiding Attunement description, the level-up from a manual +1
 * and deed labels in the history.
 */

const DEEDS = JSON.parse(readFileSync(new URL("../data/ansu/deeds.json", import.meta.url), "utf8"));
const CONTENT_RAW = JSON.parse(readFileSync(new URL("../data/ansu/content.json", import.meta.url), "utf8"));

const FLAG = "flags.the-shards-subsystems.ansu";
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id9",
    fetchJsonWithTimeout: async (path) => (path.endsWith("deeds.json") ? DEEDS : CONTENT_RAW),
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = { getWhisperRecipients: () => [], getSpeaker: () => ({}), create: async () => null };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 }, JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
globalThis.JournalEntry = {
  create: async (data) => ({ id: "j1", pages: { contents: [{ update: async () => null }] }, update: async () => null, ...data }),
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k, d = {}) => `${k} ${Object.values(d).join(" ")}` },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "gm1", isGM: true },
  journal: { get: () => null },
  combats: { contents: [] },
  scenes: { get: () => null },
  actors: { get: () => null },
  time: { worldTime: 1000 },
};
globalThis.CONFIG = { time: { roundTime: 6 } };
globalThis.fromUuidSync = () => null;
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

const { indexContent } = await import("../src/subsystems/ansu/content.mjs");
const {
  buildCtx, injectNumbers, bakeActionData, frequencyTag, composeActions, composeCommunion, composeAttunement, recallsLabel,
} = await import("../src/subsystems/ansu/logic/reconcile.mjs");
const { buildAttunementSource } = await import("../src/subsystems/ansu/sync.mjs");
const { adjustBar } = await import("../src/subsystems/ansu/mechanics/deeds.mjs");
const { describeEntry } = await import("../src/subsystems/ansu/journal.mjs");
const { indexDeeds } = await import("../src/subsystems/ansu/logic/deeds.mjs");

const CONTENT = indexContent(CONTENT_RAW);
const CALL = CONTENT.byId.get("call-the-blade");

const state = (over = {}) => ({
  enabled: true, level: 3, terminal: null, suppressed: [], loyalty: 5, wrath: 0,
  communion: { mode: "none", rounds: null }, pendingRelease: null, seizure: null, cooldowns: [], log: [], ...over,
});

describe("blade tokens", () => {
  it("buildCtx carries range, uses and throw increment from model.mjs", () => {
    expect(buildCtx(6, 3)).toMatchObject({ recallRange: 40, recalls: 1, throwInc: 30 });
    expect(buildCtx(12, 6, {}, { loyalty: 8 })).toMatchObject({ recallRange: 80, recalls: 3, throwInc: 40 });
    expect(buildCtx(20, 10).recalls).toBe(Infinity);
  });
  it("injectNumbers bakes the three tokens, unlimited uses at level 10", () => {
    const t = "{{ansuRecallRange}} ft, {{ansuRecalls}} uses, {{ansuThrowInc}} ft";
    expect(injectNumbers(t, buildCtx(14, 7))).toBe("100 ft, 3 uses, 60 ft");
    expect(injectNumbers(t, buildCtx(20, 10))).toBe("300 ft, unlimited uses, 80 ft");
    expect(recallsLabel(2)).toBe("2");
  });
  it("Call the Blade's frequency is the recall count, and none at level 10", () => {
    expect(bakeActionData(CALL.actionData, buildCtx(10, 5)).frequency).toEqual({ max: 2, per: "day" });
    expect(bakeActionData(CALL.actionData, buildCtx(10, 5, {}, { loyalty: 7 })).frequency.max).toBe(3);
    const ten = bakeActionData(CALL.actionData, buildCtx(20, 10));
    expect(ten.frequency).toBeNull();
    expect(ten.perCommunion).toBe(false);
    expect(frequencyTag(ten)).toBe("");
    expect(frequencyTag(bakeActionData(CALL.actionData, buildCtx(10, 5)))).toBe("2/communion");
  });
  it("the sheet item and the Communion effect quote the baked count", () => {
    const st = state({ level: 5, communion: { mode: "active", rounds: 5 } });
    const acts = composeActions(st, CONTENT, { charLevel: 10 });
    const call = acts.find((a) => a.entryId === "call-the-blade");
    expect(call.actionData.frequency).toEqual({ max: 2, per: "day" });
    expect(call.description).toContain("as far as 60 feet");
    expect(call.description).toContain("Uses per Communion: 2.");
    expect(acts.find((a) => a.entryId === "throw-the-blade").description).toContain("40 feet"); // Discipline
    const lines = composeCommunion(st, CONTENT, { charLevel: 10 }).abilityLines;
    expect(lines.find((l) => l.name === "Call the Blade").tag).toBe("2/communion");
  });
  it("a trust-band bearer gets one more recall, and the item re-hashes", () => {
    const st = state({ level: 5, communion: { mode: "active", rounds: 5 } });
    const wary = composeActions(st, CONTENT, { charLevel: 10 }).find((a) => a.entryId === "call-the-blade");
    const trust = composeActions({ ...st, loyalty: 7 }, CONTENT, { charLevel: 10 }).find((a) => a.entryId === "call-the-blade");
    expect(trust.actionData.frequency.max).toBe(3);
    expect(trust.hash).not.toBe(wary.hash);
  });
});

describe("Blade's Return on the sheet", () => {
  it("is there with Communion dormant from level 3, not below", () => {
    const ids = (lvl) => composeActions(state({ level: lvl }), CONTENT, { charLevel: 10, now: 0 }).map((a) => a.entryId);
    expect(ids(3)).toEqual(["invoke-the-ansu", "blades-return"]);
    expect(ids(2)).toEqual(["invoke-the-ansu"]);
  });
  it("greys out while its 10-minute cooldown runs", () => {
    const st = state({ cooldowns: [{ id: "blades-return", until: 600 }] });
    const ret = (now) => composeActions(st, CONTENT, { charLevel: 10, now }).find((a) => a.entryId === "blades-return");
    expect(ret(100).actionData.frequencyValue).toBe(0);
    expect(ret(700).actionData.frequencyValue).toBe(1);
  });
});

describe("the Attunement effect and the DC setting", () => {
  const st = state({ level: 4, loyalty: 7 });
  it("hides the DCs when the setting is GM only, and re-hashes on the switch", () => {
    const gm = composeAttunement(st, { entries: [] }, { charLevel: 9, showDc: "gm" });
    const owner = composeAttunement(st, { entries: [] }, { charLevel: 9, showDc: "owner" });
    expect(gm.hideDc).toBe(true);
    expect(owner.hideDc).toBe(false);
    expect(gm.hash).not.toBe(owner.hash);
    const hidden = buildAttunementSource(gm).system.description.value;
    expect(hidden).toContain("SHARDS.Ansu.MarkerLengthsNoDc");
    expect(hidden).not.toContain(" 27 ");
    expect(buildAttunementSource(owner).system.description.value).toContain("SHARDS.Ansu.MarkerLengths 27");
  });
});

function bearer(flagState) {
  const flag = { ...state(), log: [], ...flagState };
  const items = [];
  items.get = () => undefined;
  items.find = () => undefined;
  const actor = {
    flag, id: "a1", uuid: "Actor.a1", name: "Bearer", items, rules: [],
    system: { details: { level: { value: 12 } }, attributes: { hp: { value: 60, max: 60 } } },
    getFlag: () => flag,
    hasCondition: () => false,
    testUserPermission: () => false,
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
    setFlag: async () => null,
    createEmbeddedDocuments: async () => [],
    updateEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => [],
  };
  return actor;
}

describe("a manual +1 to loyalty 10", () => {
  it("runs the deed's level-up check", async () => {
    const actor = bearer({ level: 4, loyalty: 9, wrath: 1 });
    expect(await adjustBar(actor, "loyalty", +1)).toBe(5);
    expect(actor.flag).toMatchObject({ level: 5, loyalty: 5, wrath: 0 });
    expect(actor.flag.log.map((e) => e.type)).toEqual(["adjust", "level"]);
    expect(actor.flag.log[1].data).toMatchObject({ from: 4, to: 5 });
  });
  it("stops at 10 when the gate or wrath blocks the rise", async () => {
    const gated = bearer({ level: 6, loyalty: 9, wrath: 0 }); // character 12: gate 6
    expect(await adjustBar(gated, "loyalty", +1)).toBe(10);
    expect(gated.flag.level).toBe(6);
    const angry = bearer({ level: 4, loyalty: 9, wrath: 3 });
    expect(await adjustBar(angry, "loyalty", +1)).toBe(10);
    expect(angry.flag.level).toBe(4);
  });
});

describe("deed labels in the history", () => {
  it("describeEntry names the deed by its label when the index is given", () => {
    const deeds = indexDeeds(DEEDS);
    const e = { type: "deed", data: { deed: "victory", loyalty: [5, 6], wrath: [1, 0] } };
    expect(describeEntry(e, deeds)).toContain("Hard-won victory over a strong enemy");
    expect(describeEntry(e)).toContain("victory");
    expect(describeEntry({ type: "deed", data: { deed: "gone" } }, deeds)).toContain("gone");
  });
});
