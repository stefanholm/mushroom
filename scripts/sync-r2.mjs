// sync-r2.mjs — synka en bakad revision till R2 i avgränsade delmängder med hög parallellitet.
// Lärdom (handoff 2026-11-27): tiotusentals små JSON-filer styckvis i EN stor `rclone sync`
// är långsamt — kör per delmapp med --transfers 16 --checkers 16 istället.
//
//   node scripts/sync-r2.mjs --rev r16                     # allt under data/r2 + tile-cache
//   node scripts/sync-r2.mjs --rev r16 --only hotspots,zones # bara utvalda delar
//   node scripts/sync-r2.mjs --rev r16 --dry               # visa kommandon utan att köra
//   node scripts/sync-r2.mjs --src /Volumes/HD2021/SvampradarData/r2_ready   # färdigpaketerat träd
//       (--src synkar hela trädet, dvs det som ligger under <src>/domains -> r2:natureradar-data/domains)
//   node scripts/sync-r2.mjs --rev r16 --remote r2:natureradar-data     # annan rclone-remote
//   node scripts/sync-r2.mjs --rev r16 --delete            # VARNING: rclone sync (raderar remote-extras)
//
// VIKTIGT (lärdom 2026-11-27): default är ADDITIV upload (rclone copy) — aldrig `sync`, för sync
// raderar allt i målet som saknas lokalt (vi råkade tömma domains/fungi/r15/ root när lokal
// data/r2 saknade bake-root-filerna). Använd --delete ENDAST vid hel revisionsväxling.
//
// Förväntar sig rclone-remote "r2" -> bucket natureradar-data (rclone config).
// Baka alltid i /Volumes/HD2021/SvampradarData/r2_ready/ och byt DEFAULT_TILE_REV i
// worker/wrangler.toml FÖRST när hela revisionen är synkad (immutable deploy).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REV = arg("rev", "r15");
const dry = args.includes("--dry");
const only = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const SRC = arg("src", "");
const REMOTE_ROOT = arg("remote", "r2:natureradar-data");
const REMOTE = `${REMOTE_ROOT}/domains/fungi/${REV}`;

// --src: färdigpaketerat träd (t.ex. r2_ready med domains/fungi/<rev>/...) — synka hela domains/
if (SRC) {
  const srcDomains = path.join(SRC, "domains");
  if (!fs.existsSync(srcDomains)) { console.error(`--src ${SRC}: hittar ingen ${srcDomains}`); process.exit(1); }
  const cmd = ["rclone", args.includes("--delete") ? "sync" : "copy", srcDomains + "/", `${REMOTE_ROOT}/domains/`, "--transfers", "16", "--checkers", "16", "--stats", "30s"];
  console.log(`=== --src: ${srcDomains} -> ${REMOTE_ROOT}/domains/`);
  if (dry) { console.log("  " + cmd.join(" ")); process.exit(0); }
  const t = Date.now();
  execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  console.log(`KLART på ${((Date.now() - t) / 1000).toFixed(0)} s. Byt DEFAULT_TILE_REV="${REV}" sist, sedan: cd worker && wrangler deploy`);
  process.exit(0);
}

// [namn, lokal källa, mål under REMOTE]
const PARTS = [
  ["root", path.join(root, "data/r2"), ""],                    // manifest.json, catalog.json, shop.json
  ["tiles", path.join(root, "data/tile-cache", REV), "tiles"],   // z5-z10 (~250k filer — största delen)
  ["icons", path.join(root, "public/icons"), "icons"],
  ["overview", path.join(root, "data/overview"), "overview"],
  ["hotspots", path.join(root, "data/r2/hotspots"), "hotspots"], // 10x10 km-block
  ["zones", path.join(root, "data/r2/zones"), "zones"],
];

const todo = only.length > 0 ? PARTS.filter(([n]) => only.includes(n)) : PARTS;
for (const [name, src, dst] of todo) {
  if (!fs.existsSync(src)) { console.log(`hoppar över ${name}: ${src} saknas`); continue; }
  const target = dst ? `${REMOTE}/${dst}/` : `${REMOTE}/`;
  const del = args.includes("--delete");
  const cmd = ["rclone", del ? "sync" : "copy", src + "/", target, "--transfers", "16", "--checkers", "16", "--stats", "10s"];
  if (del) cmd.push("--progress");
  console.log(`\n=== ${name}: ${src} -> ${target}`);
  if (dry) { console.log("  " + cmd.join(" ")); continue; }
  const t = Date.now();
  execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  console.log(`=== ${name} klar på ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
console.log(`\nKLART rev=${REV}. Byt DEFAULT_TILE_REV="${REV}" i worker/wrangler.toml och kör: cd worker && wrangler deploy`);
