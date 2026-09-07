/**
 * Pure view-model decisions for the Ansu GM panel.
 *
 * The panel itself is a thin builder over Foundry documents, so anything it has
 * to DECIDE lives here instead: what the Release DC box should show, and which
 * state dot a roster row earns. Both were wrong in ways no test could catch
 * while the answer lived inline in an ApplicationV2 subclass. No Foundry
 * imports.
 */

import { communionMode } from "./reconcile.mjs";

/**
 * What the Release DC input renders.
 *
 * The typed draft wins, but an EMPTY box is not a draft: `draft ?? suggested`
 * let "" through, so clearing the field blanked the DC for every bearer and
 * every render afterwards until a number was typed and the trigger pressed.
 * (0.6.6)
 */
export function dcDraftValue({ draft, suggested } = {}) {
  if (draft === null || draft === undefined) return suggested;
  return String(draft).trim() === "" ? suggested : draft;
}

/**
 * The state dots a roster row shows, derived rather than read raw.
 *
 * The panel computed `communing` straight off `state.communion.mode` and then
 * rendered it nowhere, so two bearers mid-fight looked identical to a dormant
 * one. The raw read also mislabels a subjugated master, whose derived mode is
 * "permanent", and Lingering deserves its own mark: the boons are live and a
 * save is due at the end of every turn. (0.6.6)
 *
 * @returns {{active: boolean, lingering: boolean, seized: boolean}}
 */
export function rosterDots(state) {
  const mode = communionMode(state ?? {});
  return {
    active: mode === "active",
    lingering: mode === "lingering",
    // "taken" is the Ansu holding the body for good; the dot means the same thing.
    seized: mode === "seized" || mode === "taken",
  };
}
