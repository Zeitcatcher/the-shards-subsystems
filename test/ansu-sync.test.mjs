import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encounterOf,
  inActiveCombat,
  communionDuration,
  buildAttunementSource,
} from "../src/subsystems/ansu/sync.mjs";

/**
 * `encounterOf` walks the whole world collection of encounters. The bug it fixes:
 * `game.combat` is the encounter of the scene the CLIENT is looking at, and the
 * sync runs on the primary GM's client — so a GM who flipped the canvas away
 * composed a Communion with no countdown at all.
 */
const combat = (started, actors) => ({ started, combatants: actors.map((actor) => ({ actor })) });

describe("encounterOf", () => {
  const bearer = { id: "a1", uuid: "Actor.a1" };
  const other = { id: "b2", uuid: "Actor.b2" };

  beforeEach(() => {
    globalThis.game = { combats: { contents: [] }, combat: null };
  });
  afterEach(() => {
    delete globalThis.game;
  });

  it("finds the bearer's own encounter on a scene the client is not viewing", () => {
    const theirs = combat(true, [bearer, other]);
    // game.combat is the viewed scene's encounter, which the bearer is not in
    game.combat = combat(true, [other]);
    game.combats.contents = [game.combat, theirs];
    expect(encounterOf(bearer)).toBe(theirs);
    expect(inActiveCombat(bearer)).toBe(true);
  });

  it("matches a token actor by uuid as well as by identity", () => {
    const token = { id: "base9", uuid: "Scene.s1.Token.t1.Actor.base9" };
    game.combats.contents = [combat(true, [{ id: "base9", uuid: "Scene.s1.Token.t1.Actor.base9" }])];
    expect(inActiveCombat(token)).toBe(true);
  });

  it("ignores an encounter that has not started", () => {
    game.combats.contents = [combat(false, [bearer])];
    expect(encounterOf(bearer)).toBeNull();
    expect(inActiveCombat(bearer)).toBe(false);
  });

  it("is null when the actor is in no encounter at all", () => {
    game.combats.contents = [combat(true, [other])];
    expect(encounterOf(bearer)).toBeNull();
    expect(inActiveCombat(bearer)).toBe(false);
  });

  it("survives an empty or missing collection and a missing actor", () => {
    expect(encounterOf(bearer)).toBeNull();
    expect(encounterOf(null)).toBeNull();
    game.combats = undefined;
    expect(inActiveCombat(bearer)).toBe(false);
  });
});

describe("communionDuration", () => {
  const active = { mode: "active", permanent: false, durationRounds: 3 };

  it("runs a rounds countdown only inside a started encounter", () => {
    expect(communionDuration(active, true)).toEqual({
      value: 3,
      unit: "rounds",
      sustained: false,
      expiry: "turn-start",
    });
  });

  it("is unlimited out of combat: the GM ends it from the panel", () => {
    expect(communionDuration(active, false).unit).toBe("unlimited");
  });

  it("never expires while lingering, seized, or at a terminal", () => {
    for (const composed of [
      { mode: "lingering", permanent: false, durationRounds: 3 },
      { mode: "seized", permanent: false, durationRounds: 3 },
      { mode: "permanent", permanent: true, durationRounds: null },
      { mode: "taken", permanent: true, durationRounds: null },
    ]) {
      expect(communionDuration(composed, true).unit).toBe("unlimited");
      expect(communionDuration(composed, false).unit).toBe("unlimited");
    }
  });

  it("floors a missing or junk round count at 1", () => {
    expect(communionDuration({ mode: "active", durationRounds: 0 }, true).value).toBe(1);
    expect(communionDuration({ mode: "active", durationRounds: null }, true).value).toBe(1);
  });
});

/**
 * pf2e DELETES a counter effect decremented below its minimum, so `min: 1` meant
 * right-clicking the marker at attunement 1 destroyed it and the self-heal put it
 * straight back at 1: the badge flickered and the level never reached 0. pf2e's
 * own `badge.min = badge.labels ? 1 : (badge.min ?? 1)` keeps an explicit 0.
 * (item 17)
 */
describe("buildAttunementSource", () => {
  const composed = {
    level: 3,
    tier: "trial",
    terminal: null,
    badge: { value: 3, max: 9 },
    rules: [],
    inheritanceLines: [],
    releaseDc: 26,
    durationRounds: 1,
    hash: "h1",
  };

  beforeEach(() => {
    globalThis.game = {
      i18n: { localize: (k) => k, format: (k) => k },
      settings: { get: () => false },
    };
  });
  afterEach(() => {
    delete globalThis.game;
  });

  it("lets the counter be driven all the way down to 0", () => {
    expect(buildAttunementSource(composed).system.badge.min).toBe(0);
  });
  it("keeps the value and the ceiling the composer decided", () => {
    const badge = buildAttunementSource(composed).system.badge;
    expect(badge).toEqual({ type: "counter", value: 3, min: 0, max: 9 });
  });
});
