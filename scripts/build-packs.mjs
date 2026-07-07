/**
 * Compile the committed source documents in src/packs/<name>/*.json into the LevelDB
 * compendium packs Foundry loads (packs/<name>/). Run after build-pack-sources.mjs,
 * and before cutting a release so the packs ship in the distributed module.
 *
 *   npm run build:packs
 *
 * The compiled packs/ directory is gitignored (a build artifact); only the source
 * JSON under src/packs/ is committed.
 */
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePack } from "@foundryvtt/foundryvtt-cli";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = [
  { src: "src/packs/izir-effects", dest: "packs/izir-effects" },
  { src: "src/packs/ansu-effects", dest: "packs/ansu-effects" },
];

for (const p of PACKS) {
  const dest = resolve(ROOT, p.dest);
  rmSync(dest, { recursive: true, force: true });
  await compilePack(resolve(ROOT, p.src), dest, { log: true });
  console.log(`build-packs: compiled ${p.src} -> ${p.dest}`);
}
