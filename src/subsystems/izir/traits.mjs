/**
 * Register homebrew pf2e creature traits so they appear in the actor trait selector
 * (alongside humanoid, dragon, electricity, …) and can be tagged on any token.
 * Done at `setup`, after pf2e has populated CONFIG.PF2E and before any sheet renders.
 */

const TRAITS = [
  {
    slug: "nameless",
    label: "Nameless",
    description:
      "A being whose First Name has been severed and who now carries Izir. Registered by The Shards — Campaign Subsystems.",
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

export function registerIzirTraits() {
  const pf2e = CONFIG?.PF2E;
  if (!pf2e?.creatureTraits) return;
  for (const t of TRAITS) {
    addTo(pf2e, "creatureTraits", t.slug, t.label);
    if (pf2e.traitsDescriptions) addTo(pf2e, "traitsDescriptions", t.slug, t.description);
  }
}
