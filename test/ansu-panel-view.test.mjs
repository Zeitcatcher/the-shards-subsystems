import { describe, it, expect } from "vitest";
import { dcDraftValue, rosterDots } from "../src/subsystems/ansu/logic/panel.mjs";

/**
 * The panel's own decisions, lifted out of the ApplicationV2 subclass so they
 * can be pinned. Both were wrong: the Release DC box let an empty string count
 * as a typed draft, and the roster computed a "communing" flag off the raw
 * communion mode that the template then never rendered. (items 21 and 23)
 */
const state = (over = {}) => ({
  level: 4,
  terminal: null,
  communion: { mode: "none", rounds: null },
  ...over,
});

describe("dcDraftValue", () => {
  it("shows the computed suggestion when nothing has been typed", () => {
    expect(dcDraftValue({ draft: null, suggested: 26 })).toBe(26);
    expect(dcDraftValue({ draft: undefined, suggested: 26 })).toBe(26);
  });

  it("shows the GM's typed draft", () => {
    expect(dcDraftValue({ draft: "31", suggested: 26 })).toBe("31");
    expect(dcDraftValue({ draft: 31, suggested: 26 })).toBe(31);
  });

  it("treats an emptied box as no draft, so the suggestion comes back", () => {
    expect(dcDraftValue({ draft: "", suggested: 26 })).toBe(26);
    expect(dcDraftValue({ draft: "   ", suggested: 26 })).toBe(26);
  });

  it("keeps a draft of 0: it is a bad DC, not an absent one, and BadDc catches it", () => {
    expect(dcDraftValue({ draft: "0", suggested: 26 })).toBe("0");
  });

  it("survives junk input", () => {
    expect(dcDraftValue()).toBeUndefined();
    expect(dcDraftValue({})).toBeUndefined();
    expect(dcDraftValue({ draft: "nope", suggested: 26 })).toBe("nope");
  });
});

describe("rosterDots", () => {
  it("marks a running Communion and a Lingering wrestle apart", () => {
    expect(rosterDots(state({ communion: { mode: "active" } }))).toEqual({
      active: true,
      lingering: false,
      seized: false,
    });
    expect(rosterDots(state({ communion: { mode: "lingering" } }))).toEqual({
      active: false,
      lingering: true,
      seized: false,
    });
  });

  it("leaves a dormant bearer unmarked", () => {
    expect(rosterDots(state())).toEqual({ active: false, lingering: false, seized: false });
  });

  it("does not call a subjugated master's permanent Communion 'active'", () => {
    expect(rosterDots(state({ level: 10, terminal: "subjugated", communion: { mode: "active" } }))).toEqual({
      active: false,
      lingering: false,
      seized: false,
    });
  });

  it("marks both ways the Ansu can hold the body", () => {
    expect(rosterDots(state({ communion: { mode: "seized" } })).seized).toBe(true);
    expect(rosterDots(state({ level: 10, terminal: "taken", communion: { mode: "none" } })).seized).toBe(true);
  });

  it("never lights two dots at once: the modes are exclusive", () => {
    for (const communion of [{ mode: "none" }, { mode: "active" }, { mode: "lingering" }, { mode: "seized" }]) {
      const lit = Object.values(rosterDots(state({ communion }))).filter(Boolean);
      expect(lit.length).toBeLessThanOrEqual(1);
    }
  });

  it("survives junk input", () => {
    expect(rosterDots()).toEqual({ active: false, lingering: false, seized: false });
    expect(rosterDots(null)).toEqual({ active: false, lingering: false, seized: false });
    expect(rosterDots({})).toEqual({ active: false, lingering: false, seized: false });
  });
});
