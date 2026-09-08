/**
 * The pf2e creature-trait slug this module marks the Nameless with.
 *
 * The trait itself is declared in module.json under
 * `flags.<id>.pf2e-homebrew.creatureTraits`, which is what pf2e actually reads at
 * setup: label and description both come from there. A runtime registrar used to
 * live here too, writing the same slug into CONFIG.PF2E — it changed nothing a
 * GM could see, and its description had already drifted from the manifest's. The
 * manifest is the single source now; this file only names the slug. (F40)
 */
export const NAMELESS_TRAIT = "nameless";
