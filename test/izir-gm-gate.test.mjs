import { describe, it, expect, beforeEach } from "vitest";

/**
 * The Izir panel is a GM dashboard, and nothing but the scene-control button ever
 * gated it. The module API — `game.modules.get(...).api.openPanel("izir")`,
 * mirrored on `globalThis.TheShardsSubsystems` — is defined on every client, so a
 * player who ran the launcher macro or typed one line in the console got the whole
 * dashboard, and Foundry then let them drive their OWN immersion track, suppress
 * their own prices and record their own temptation outcomes, because they own the
 * actor. (H1)
 *
 * Globals go up before the dynamic import. The ApplicationV2 stub records renders
 * so "the panel never opened" is an assertion rather than an absence of errors.
 */
const renders = [];
const warnings = [];

class FakeApp {
  render(options) {
    renders.push(options ?? {});
    return this;
  }
}

globalThis.foundry = {
  applications: {
    api: { ApplicationV2: FakeApp, HandlebarsApplicationMixin: (base) => base },
  },
  utils: {
    escapeHTML: (s) => String(s ?? ""),
    randomID: () => "id1",
    fetchJsonWithTimeout: async () => ({ version: 1, entries: [], tiers: [] }),
  },
};
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.ChatMessage = {
  getWhisperRecipients: () => [{ id: "gm1" }],
  getSpeaker: () => ({}),
  create: async () => {},
};
globalThis.game = {
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => "gm" },
  users: { contents: [], activeGM: { id: "gm1" } },
  user: { id: "u1", isGM: false },
  actors: { contents: [], get: () => null },
  combats: { contents: [] },
  scenes: { get: () => null, contents: [] },
  modules: { get: () => ({}) },
};
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.fromUuidSync = () => null;
globalThis.ui = {
  notifications: {
    warn: (m) => warnings.push(m),
    info: (m) => warnings.push(m),
    error: (m) => warnings.push(m),
  },
};

const { IzirPanel, openIzirPanel } = await import("../src/subsystems/izir/apps/izir-panel.mjs");

const asPlayer = () => (game.user = { id: "u1", isGM: false });
const asGM = () => (game.user = { id: "gm1", isGM: true });

describe("the Izir panel is GM-only", () => {
  beforeEach(() => {
    renders.length = 0;
    warnings.length = 0;
  });

  it("refuses to open for a player, whatever called it", () => {
    asPlayer();
    openIzirPanel();
    expect(renders).toHaveLength(0);
    expect(warnings).toContain("SHARDS.Izir.GmOnly");
  });

  it("refuses to render even if an instance is reached another way", () => {
    asPlayer();
    expect(new IzirPanel()._canRender()).toBe(false);
  });

  it("opens and renders for the GM", () => {
    asGM();
    openIzirPanel();
    expect(renders).toHaveLength(1);
    expect(new IzirPanel()._canRender()).toBe(true);
  });

  it("guards every action handler, not just the entry point", () => {
    const actions = IzirPanel.DEFAULT_OPTIONS.actions;
    // The map is the whole control surface; none of it may be reachable.
    expect(Object.keys(actions).length).toBeGreaterThan(15);
    asPlayer();
    for (const [name, handler] of Object.entries(actions)) {
      warnings.length = 0;
      handler.call({ _actorUuid: null, render() {} });
      expect(warnings, `${name} ran for a player`).toEqual(["SHARDS.Izir.GmOnly"]);
    }
  });

  it("lets the GM's own clicks through to the handler", () => {
    asGM();
    // markSelected with no token controlled warns MarkedNone — proof the real
    // handler ran rather than the guard.
    IzirPanel.DEFAULT_OPTIONS.actions.markSelected.call({ _actorUuid: null, render() {} });
    expect(warnings).toContain("SHARDS.Izir.MarkedNone");
    expect(warnings).not.toContain("SHARDS.Izir.GmOnly");
  });
});
