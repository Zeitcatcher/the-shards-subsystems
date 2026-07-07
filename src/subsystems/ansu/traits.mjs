/**
 * Register the homebrew pf2e creature trait for Ansu-bearers so it appears in the
 * actor trait selector and can be tagged on any token. Done at `setup`, after pf2e
 * has populated CONFIG.PF2E and before any sheet renders.
 */

/** The pf2e creature-trait slug this subsystem registers and auto-applies on attuning. */
export const MURKHOR_TRAIT = "murkhor";

const TRAITS = [
  {
    slug: MURKHOR_TRAIT,
    label: "Murkhor",
    description:
      "A murkhor — one of the ancient race of engineers, bearing an Ansu: the strength and knowledge of the ancestors. Registered by The Shards — Campaign Subsystems.",
  },
];

function addTo(pf2e, dictName, key, value) {
  const dict = pf2e[dictName];
  if (!dict || key in dict) return;
  try {
    dict[key] = value;
  } catch {
    // Some CONFIG dictionaries may be frozen — replace the whole object instead.
    pf2e[dictName] = { ...dict, [key]: value };
  }
}

export function registerAnsuTraits() {
  const pf2e = CONFIG?.PF2E;
  if (!pf2e?.creatureTraits) return;
  for (const t of TRAITS) {
    addTo(pf2e, "creatureTraits", t.slug, t.label);
    if (pf2e.traitsDescriptions) addTo(pf2e, "traitsDescriptions", t.slug, t.description);
  }
}
