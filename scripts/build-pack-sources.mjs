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
const DEFAULT_ACTION_IMG = "icons/magic/unholy/projectile-helix-blood-red.webp";
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

/** Pack copies are static: replace the runtime number tokens with readable text. */
function scrub(text) {
  return String(text ?? "")
    .replaceAll("{{izirDC}}", "your Izir DC")
    .replaceAll("{{izirAttack}}", "your Izir attack modifier")
    .replaceAll("{{izirLevel}}", "your immersion level")
    .replaceAll("{{izirHolyWeak}}", "2 (4 at immersion 6, 6 at 8)");
}

/** Pack-copy rules with number tokens neutralized (static docs can't compute). */
function scrubRules(rules) {
  return (Array.isArray(rules) ? rules : []).map((r) => {
    const out = { ...r };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "string" && v.includes("{{izirHolyWeak}}")) out[k] = 2;
    }
    return out;
  });
}

function folderDoc(f, index) {
  const id = folderId(f.key);
  return { _id: id, _key: `!folders!${id}`, name: f.name, type: "Item", sorting: "m", folder: null, sort: (index + 1) * 100000 };
}

function baseSystemEffect(entry) {
  return {
    description: { value: scrub(entry.description) },
    slug: `shards-izir-${entry.id}`,
    duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
    unidentified: false,
    level: { value: 1 },
    tokenIcon: { show: true },
    badge: null,
    traits: { value: [], rarity: "common" },
    rules: scrubRules(entry.rules),
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
      description: { value: scrub(entry.description) },
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
  if (entry.form === "strike") {
    // Reusable copy grants the Strike via rule element; without the tracker there is
    // no Izir attack modifier, so the strike falls back to the actor's own math.
    // Official Strike RE shape (dragonet jaws): no category field.
    const s = entry.strikeData ?? {};
    const doc = effectItem(entry);
    doc.system.rules = [
      ...scrubRules(entry.rules),
      {
        key: "Strike",
        slug: `shards-izir-${entry.id}`,
        label: entry.name,
        img: entry.img,
        group: s.group ?? "brawling",
        traits: s.traits ?? ["magical", "unarmed", "void"],
        range: s.range ?? null,
        damage: { base: { damageType: s.damageType ?? "void", dice: 1, die: s.die ?? "d4" } },
      },
    ];
    return doc;
  }
  // effect + (future) spell fall back to a browsable effect card
  return effectItem(entry);
}

function packEffectItem(pe) {
  const duration = Number.isInteger(pe.durationMinutes)
    ? { value: pe.durationMinutes, unit: "minutes", sustained: false, expiry: "turn-end" }
    : { value: -1, unit: "unlimited", sustained: false, expiry: null };
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
      duration,
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

/**
 * One generated "Recharge: <name>" effect per recharge active. Its _id is derived
 * from the entry id with the same makeId rule the runtime uses, so the action's
 * selfEffect UUID can be computed without storing it in content.json. The 1-round
 * duration is a placeholder: the module rolls the recharge die and overwrites it.
 */
function rechargeEffectItem(entry) {
  const id = makeId(`rc-${entry.id}`);
  return {
    _id: id,
    _key: `!items!${id}`,
    name: `Recharge: ${entry.name}`,
    type: "effect",
    img: "icons/magic/time/hourglass-tilted-glowing-gold.webp",
    folder: folderId("internal"),
    sort: 200,
    system: {
      description: {
        value: `<p>${entry.name} is spent. The remaining rounds count down on this effect; the ability is available again when it ends.</p>`,
      },
      slug: `shards-izir-recharge-${entry.id}`,
      duration: { value: 1, unit: "rounds", sustained: false, expiry: "turn-start" },
      unidentified: false,
      level: { value: 1 },
      tokenIcon: { show: true },
      badge: null,
      traits: { value: [], rarity: "common" },
      rules: [],
      start: { value: 0, initiative: null },
      publication: PUBLICATION,
    },
    flags: { [MODULE_ID]: { izirRecharge: entry.id } },
  };
}

const rechargeEntries = (content.entries ?? []).filter((e) => e.actionData?.recharge);

const docs = [
  ...FOLDERS.map(folderDoc),
  ...(content.entries ?? []).map(entryItem),
  ...rechargeEntries.map(rechargeEffectItem),
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
