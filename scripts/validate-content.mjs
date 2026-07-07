/**
 * CI + pretest guard: validate every subsystem's content.json against the same
 * schema the module uses at runtime (reused from each content.mjs, so there's
 * one source of truth per subsystem).
 *
 *   node scripts/validate-content.mjs
 */
import { readFileSync } from "node:fs";
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
if (failed) process.exit(1);
