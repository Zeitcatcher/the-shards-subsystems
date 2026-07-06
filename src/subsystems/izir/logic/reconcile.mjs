/**
 * Pure reconciliation core. No Foundry imports — fully vitest-covered.
 *
 * `computeDesired` turns (flag state + indexed content) into the exact set of items
 * that SHOULD be on the actor. `diffItems` compares that against what IS on the actor
 * (projected by sync.mjs) and returns the minimal create/delete/update operations.
 */

const MARKER_ID = "izir-marker";
export const MARKER_FAMILY = "izir-marker";

/**
 * The desired item set for an actor, most-significant first (marker, then by level).
 * @param {object} state    healed Izir flag state
 * @param {object} content  indexed content ({ entries, ... })
 * @param {object} [opts]   { transparency:boolean }
 * @returns {Array} desired entries: { entryId, family, kind, form, identified, hash, entry?, marker? }
 */
export function computeDesired(state, content, opts = {}) {
  const transparency = Boolean(opts.transparency);

  // Consumed: nothing but the terminal marker remains.
  if (state.terminal === "nineveh") return [markerDesired(state)];
  if (!state.enabled) return [];

  const subjugated = state.terminal === "subjugated";
  if (state.level < 1 && !subjugated) return [];

  const suppressed = new Set((state.suppressed ?? []).map((s) => s.id));
  const revealed = new Set(state.revealed ?? []);
  const entries = content?.entries ?? [];

  // 1. candidates: unlocked by level, gate satisfied.
  const candidates = entries.filter((e) => {
    if (e.gate === "subjugated") return subjugated;
    return e.level <= state.level;
  });

  // 2. per family, keep the highest rank (replacement: Izir Wave I → II).
  const bestByFamily = new Map();
  for (const e of candidates) {
    const cur = bestByFamily.get(e.family);
    if (!cur || (e.rank ?? 0) > (cur.rank ?? 0)) bestByFamily.set(e.family, e);
  }

  // 3. drop suppressed families; annotate identified.
  const desired = [];
  for (const e of bestByFamily.values()) {
    if (suppressed.has(e.family)) continue;
    const identified = e.kind === "boon" || transparency || revealed.has(e.family);
    desired.push({
      entryId: e.id,
      family: e.family,
      kind: e.kind,
      form: e.form,
      identified,
      hash: hashEntry(e),
      entry: e,
    });
  }

  // stable order for deterministic sync + tests
  desired.sort((a, b) => (a.entry.level - b.entry.level) || a.entryId.localeCompare(b.entryId));

  // 4. marker first.
  desired.unshift(markerDesired(state));
  return desired;
}

function markerDesired(state) {
  const marker = { level: state.level, terminal: state.terminal ?? null };
  return {
    entryId: MARKER_ID,
    family: MARKER_FAMILY,
    kind: "boon",
    form: "marker",
    identified: true,
    hash: hashString(`marker:${marker.level}:${marker.terminal ?? ""}`),
    marker,
  };
}

/**
 * Minimal ops to converge the actor's tagged items to `desired`.
 * @param {Array} desired  output of computeDesired
 * @param {Array} tagged   [{ itemId, entryId, family, contentHash, identified }]
 * @returns {{toCreate:Array, toDelete:Array, toUpdate:Array}}
 */
export function diffItems(desired, tagged) {
  const desiredById = new Map(desired.map((d) => [d.entryId, d]));
  const taggedById = new Map(tagged.map((t) => [t.entryId, t]));

  const toCreate = [];
  const toDelete = [];
  const toUpdate = [];

  for (const d of desired) {
    const t = taggedById.get(d.entryId);
    if (!t) {
      toCreate.push(d);
    } else if (t.contentHash !== d.hash) {
      // content changed → rebuild
      toDelete.push(t);
      toCreate.push(d);
    } else if (Boolean(t.identified) !== Boolean(d.identified)) {
      // only the reveal flag changed → cheap in-place update
      toUpdate.push({ tagged: t, desired: d });
    }
  }

  for (const t of tagged) {
    if (!desiredById.has(t.entryId)) toDelete.push(t);
  }

  return { toCreate, toDelete, toUpdate };
}

/** Stable content hash of an entry's build-relevant fields. Pure. */
export function hashEntry(entry) {
  const relevant = {
    name: entry.name ?? "",
    description: entry.description ?? "",
    img: entry.img ?? "",
    form: entry.form ?? "",
    kind: entry.kind ?? "",
    rules: entry.rules ?? [],
    actionData: entry.actionData ?? null,
    spellData: entry.spellData ?? null,
    auraEffectId: entry.auraEffectId ?? null,
  };
  return hashString(stableStringify(relevant));
}

/** Deterministic JSON with sorted object keys. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** FNV-1a 32-bit → base36. Short, stable, dependency-free. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
