import { describe, it, expect } from "vitest";
import { actorKey } from "../src/core/platform.mjs";

/**
 * The per-actor guards (sync chain, expiry lock, recording set) used to key on
 * actor.id. A synthetic (unlinked token) actor carries the BASE actor's id, so
 * two tokens of one statblock shared every guard and one token's expiry silently
 * swallowed the other's. The mechanics modules are Foundry-bound; what is
 * testable — and what the whole fix rests on — is the key itself.
 */
describe("actorKey", () => {
  it("separates two token actors that share a base actor id", () => {
    const a = { id: "base123", uuid: "Scene.s1.Token.t1.Actor.base123" };
    const b = { id: "base123", uuid: "Scene.s1.Token.t2.Actor.base123" };
    expect(actorKey(a)).not.toBe(actorKey(b));
    const guard = new Set([actorKey(a)]);
    expect(guard.has(actorKey(b))).toBe(false);
  });

  it("is the uuid for a world actor, and stable across reads", () => {
    const actor = { id: "abc", uuid: "Actor.abc" };
    expect(actorKey(actor)).toBe("Actor.abc");
    expect(actorKey(actor)).toBe(actorKey({ ...actor }));
  });

  it("falls back to the id when there is no uuid", () => {
    expect(actorKey({ id: "abc" })).toBe("abc");
  });

  it("survives junk input without throwing", () => {
    expect(actorKey()).toBe("");
    expect(actorKey(null)).toBe("");
    expect(actorKey({})).toBe("");
  });
});
