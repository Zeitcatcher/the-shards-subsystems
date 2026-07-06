/**
 * CI + pretest guard: validate data/izir/content.json against the same schema the
 * module uses at runtime (reused from content.mjs, so there's one source of truth).
 *
 *   node scripts/validate-content.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContent } from "../src/subsystems/izir/content.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(resolve(ROOT, "data/izir/content.json"), "utf8"));

const problems = validateContent(raw);
if (problems.length) {
  console.error(`content invalid:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `validate-content: ok (${raw.entries.length} entries, ${(raw.packEffects ?? []).length} pack effects).`,
);
