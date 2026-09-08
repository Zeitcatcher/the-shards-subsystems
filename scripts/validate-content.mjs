/**
 * CI guard: validate every subsystem's content.json against the same schema the
 * module uses at runtime (reused from each content.mjs, so there's one source of
 * truth per subsystem), then scan the generated pack sources.
 *
 * The pack-source checks live in scripts/pack-checks.mjs and are also run by
 * test/ansu-packs.test.mjs, so `npm test` catches what this catches.
 *
 *   node scripts/validate-content.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent as validateIzir } from "../src/subsystems/izir/content.mjs";
import { validateContent as validateAnsu } from "../src/subsystems/ansu/content.mjs";
import { packSourceTextProblems, ansuBakedNumberProblems } from "./pack-checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { name: "izir", path: "data/izir/content.json", validate: validateIzir },
  { name: "ansu", path: "data/ansu/content.json", validate: validateAnsu },
];

let failed = false;
for (const t of TARGETS) {
  const raw = JSON.parse(readFileSync(resolve(ROOT, t.path), "utf8"));
  const problems = t.validate(raw);
  if (problems.length) {
    console.error(`${t.name} content invalid:\n - ${problems.join("\n - ")}`);
    failed = true;
    continue;
  }
  console.log(
    `validate-content: ${t.name} ok (${raw.entries.length} entries, ${(raw.packEffects ?? []).length} pack effects).`,
  );
}

// Scan the generated pack sources for defects the schema can't see: unresolved
// {{tokens}} that leaked past a scrub, inline @Check enrichers whose dc is prose,
// and (Ansu) a baked rule number that disagrees with model.mjs at the entry's own
// unlock attunement. All three shipped broken content before these guards existed.
for (const dir of ["src/packs/izir-effects", "src/packs/izir-internal", "src/packs/ansu-effects"]) {
  let files;
  try {
    files = readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".json"));
  } catch {
    continue;
  }
  const docs = [];
  for (const f of files) {
    const text = readFileSync(resolve(ROOT, dir, f), "utf8");
    for (const p of packSourceTextProblems(`${dir}/${f}`, text)) {
      console.error(p);
      failed = true;
    }
    try {
      docs.push(JSON.parse(text));
    } catch (err) {
      console.error(`pack source ${dir}/${f}: not valid JSON (${err.message})`);
      failed = true;
    }
  }
  if (dir.endsWith("ansu-effects")) {
    const content = JSON.parse(readFileSync(resolve(ROOT, "data/ansu/content.json"), "utf8"));
    for (const p of ansuBakedNumberProblems(content, docs)) {
      console.error(p);
      failed = true;
    }
  }
  console.log(`validate-content: ${dir} ok (${files.length} pack sources scanned).`);
}

if (failed) process.exit(1);
