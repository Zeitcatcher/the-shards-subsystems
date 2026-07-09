/**
 * CI + pretest guard: validate every subsystem's content.json against the same
 * schema the module uses at runtime (reused from each content.mjs, so there's
 * one source of truth per subsystem).
 *
 *   node scripts/validate-content.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent as validateIzir } from "../src/subsystems/izir/content.mjs";
import { validateContent as validateAnsu } from "../src/subsystems/ansu/content.mjs";

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

// Scan the generated pack sources for two defect classes the schema can't see:
// unresolved {{tokens}} that leaked past a scrub, and inline @Check enrichers whose
// dc is prose (a letter after "dc:") instead of a number/path/empty. Both shipped
// broken content before this guard existed.
for (const dir of ["src/packs/izir-effects", "src/packs/ansu-effects"]) {
  let files;
  try {
    files = readdirSync(resolve(ROOT, dir)).filter((f) => f.endsWith(".json"));
  } catch {
    continue;
  }
  let scanned = 0;
  for (const f of files) {
    const text = readFileSync(resolve(ROOT, dir, f), "utf8");
    if (text.includes("{{")) {
      console.error(`pack source ${dir}/${f}: unresolved {{token}} left in a static pack copy`);
      failed = true;
    }
    if (/dc:[A-Za-z]/.test(text)) {
      console.error(`pack source ${dir}/${f}: malformed inline @Check dc (prose after "dc:")`);
      failed = true;
    }
    scanned += 1;
  }
  console.log(`validate-content: ${dir} ok (${scanned} pack sources scanned).`);
}

if (failed) process.exit(1);
