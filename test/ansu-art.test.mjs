import { describe, it, expect } from "vitest";
import { pickThresholdForLevel, currentTokenSrc } from "../src/subsystems/ansu/logic/art.mjs";

const slots = (a, b, c) => ({ 4: { portrait: a, token: "" }, 7: { portrait: b, token: "" }, 10: { portrait: c, token: "" } });

describe("pickThresholdForLevel (horn stages)", () => {
  it("picks the highest configured threshold at or below the level", () => {
    expect(pickThresholdForLevel(10, slots("a", "b", "c"))).toBe("10");
    expect(pickThresholdForLevel(8, slots("a", "b", "c"))).toBe("7");
    expect(pickThresholdForLevel(5, slots("a", "b", "c"))).toBe("4");
  });
  it("skips empty slots (only broken-horns and Salbarium art configured)", () => {
    expect(pickThresholdForLevel(8, slots("", "", "salb"))).toBeNull();
    expect(pickThresholdForLevel(10, slots("", "", "salb"))).toBe("10");
  });
  it("returns null below every configured threshold", () => {
    expect(pickThresholdForLevel(3, slots("a", "b", "c"))).toBeNull();
  });
});

/**
 * A synthetic (unlinked token) actor has no prototype token of its own: that one
 * belongs to the base statblock, and reading it captured the wrong picture and
 * repainted every other copy of the same NPC on the scene. (item 26)
 */
describe("currentTokenSrc", () => {
  it("reads a world actor's prototype token", () => {
    const world = { isToken: false, prototypeToken: { texture: { src: "proto.webp" } } };
    expect(currentTokenSrc(world)).toBe("proto.webp");
  });
  it("reads a synthetic actor's own placed token, not the base statblock's", () => {
    const synthetic = {
      isToken: true,
      token: { texture: { src: "placed.webp" } },
      prototypeToken: { texture: { src: "base.webp" } },
    };
    expect(currentTokenSrc(synthetic)).toBe("placed.webp");
  });
  it("is undefined when there is nothing to read, and never throws", () => {
    expect(currentTokenSrc({ isToken: true })).toBeUndefined();
    expect(currentTokenSrc({ isToken: false })).toBeUndefined();
    expect(currentTokenSrc(null)).toBeUndefined();
    expect(currentTokenSrc()).toBeUndefined();
  });
});
