/**
 * Generate the compendium SOURCE documents (committed) from content.json. Run this
 * whenever content.json changes, then `npm run build:packs` to compile the LevelDB pack.
 *
 *   node scripts/build-pack-sources.mjs
 *
 * The pack ships EVERY Izir ability as a browsable, draggable pf2e item, foldered by
 * tier, so the GM can drop any power/price onto any token independently of the tracker.
 * These reusable copies carry flags[MODULE_ID].izirPack (NOT the tracker's `.izir` tag),
 * so the reconciliation engine ignores them — dragging one on is fully manual.
 *
 * The aura-granted effects (packEffects) also live here (Internal folder); their stable
 * _ids are what the Terror's Mantle Aura rule element references.
 *
 * Output: src/packs/izir-effects/<_id>.json (folders + items; committed).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = "the-shards-subsystems";
const DEFAULT_EFFECT_IMG = "icons/magic/unholy/orb-glowing-purple.webp";
const DEFAULT_ACTION_IMG = "icons/magic/unholy/strike-beam-blood-red-purple.webp";
const PUBLICATION = { title: "The Shards", authors: "Zeitcatcher", license: "OGL", remaster: true };

const content = JSON.parse(readFileSync(resolve(ROOT, "data/izir/content.json"), "utf8"));

/** Stable 16-char Foundry id from a string. */
const makeId = (s) => s.replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0").slice(0, 16);

// Tier folders (browsing structure inside the pack).
const FOLDERS = [
  { key: "whisper", name: "Tier I — Whisper (Lv 1–3)" },
  { key: "grip", name: "Tier II — Grip (Lv 4–6)" },
  { key: "call", name: "Tier III — Call (Lv 7–9)" },
  { key: "nineveh", name: "Terminal — Nineveh & Subjugation (Lv 10)" },
  { key: "internal", name: "Internal — Aura Effects" },
];
const folderId = (key) => makeId(`izirfolder-${key}`);

function tierKeyFor(entry) {
  if (entry.gate === "subjugated") return "nineveh";
  if (entry.level <= 3) return "whisper";
  if (entry.level <= 6) return "grip";
  if (entry.level <= 9) return "call";
  return "nineveh";
}

function folderDoc(f, index) {
  const id = folderId(f.key);
  return { _id: id, _key: `!folders!${id}`, name: f.name, type: "Item", sorting: "m", folder: null, sort: (index + 1) * 100000 };
}

function baseSystemEffect(entry) {
  return {
    description: { value: entry.description ?? "" },
    slug: `shards-izir-${entry.id}`,
    duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
    unidentified: false,
    level: { value: 1 },
    tokenIcon: { show: true },
    badge: null,
    traits: { value: [], rarity: "common" },
    rules: Array.isArray(entry.rules) ? entry.rules : [],
    start: { value: 0, initiative: null },
    publication: PUBLICATION,
  };
}

function effectItem(entry) {
  const id = makeId(entry.id);
  return {
    _id: id,
    _key: `!items!${id}`,
    name: entry.name,
    type: "effect",
    img: entry.img || DEFAULT_EFFECT_IMG,
    folder: folderId(tierKeyFor(entry)),
    sort: entry.level * 1000 + (entry.kind === "boon" ? 0 : 500),
    system: baseSystemEffect(entry),
    flags: { [MODULE_ID]: { izirPack: { entryId: entry.id, family: entry.family, kind: entry.kind } } },
  };
}

function actionItem(entry) {
  const id = makeId(entry.id);
  const a = entry.actionData ?? {};
  return {
    _id: id,
    _key: `!items!${id}`,
    name: entry.name,
    type: "action",
    img: entry.img || DEFAULT_ACTION_IMG,
    folder: folderId(tierKeyFor(entry)),
    sort: entry.level * 1000 + 250,
    system: {
      description: { value: entry.description ?? "" },
      slug: `shards-izir-${entry.id}`,
      actionType: { value: a.actionType ?? "action" },
      actions: { value: a.actions ?? null },
      category: a.category ?? null,
      traits: { value: a.traits ?? [], rarity: "common" },
      frequency: a.frequency ?? null,
      rules: Array.isArray(entry.rules) ? entry.rules : [],
      publication: PUBLICATION,
    },
    flags: { [MODULE_ID]: { izirPack: { entryId: entry.id, family: entry.family, kind: entry.kind } } },
  };
}

function entryItem(entry) {
  if (entry.form === "action") return actionItem(entry);
  // effect + (future) spell fall back to a browsable effect card
  return effectItem(entry);
}

function packEffectItem(pe) {
  return {
    _id: pe._id,
    _key: `!items!${pe._id}`,
    name: pe.name,
    type: "effect",
    img: pe.img || DEFAULT_EFFECT_IMG,
    folder: folderId("internal"),
    sort: 100,
    system: {
      description: { value: pe.description ?? "" },
      slug: `shards-izir-pack-${pe._id}`,
      duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
      unidentified: false,
      level: { value: 1 },
      tokenIcon: { show: true },
      badge: null,
      traits: { value: [], rarity: "common" },
      rules: Array.isArray(pe.rules) ? pe.rules : [],
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: { [MODULE_ID]: { izir: { pack: true } } },
  };
}

function writeDir(rel, docs) {
  const dir = resolve(ROOT, rel);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const doc of docs) {
    writeFileSync(resolve(dir, `${doc._id}.json`), JSON.stringify(doc, null, 2) + "\n");
  }
  return docs.length;
}

const docs = [
  ...FOLDERS.map(folderDoc),
  ...(content.entries ?? []).map(entryItem),
  ...(content.packEffects ?? []).map(packEffectItem),
];

// Guard against id collisions from makeId truncation.
const ids = docs.map((d) => d._id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) {
  console.error(`build-pack-sources: DUPLICATE ids after makeId: ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}

const n = writeDir("src/packs/izir-effects", docs);
console.log(
  `build-pack-sources: wrote ${FOLDERS.length} folders + ${(content.entries ?? []).length} abilities + ${(content.packEffects ?? []).length} aura effect(s) = ${n} docs.`,
);
