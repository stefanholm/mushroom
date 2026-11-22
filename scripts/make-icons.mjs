// Genererar platshållar-ikoner public/icons/<speciesId>.png (512x512, transparent PNG,
// färgad cirkel med ljus kant — "sticker"-look). Kör: npm run icons  (skriver bara om saknas, --force skriver över)
// Byt ut mot riktiga bilder genom att bara lägga filer med samma namn i public/icons/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { SPECIES } from "../src/habitat.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");
const FORCE = process.argv.includes("--force");
const SIZE = 512;

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function hashStr(s) {
  let h = 2166136261;
  for (const c of s) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

fs.mkdirSync(outDir, { recursive: true });
let made = 0;
let skipped = 0;
for (const id of Object.keys(SPECIES)) {
  const out = path.join(outDir, id + ".png");
  if (!FORCE && fs.existsSync(out)) {
    skipped++;
    continue;
  }
  const h = hashStr(id) % 360;
  const [r, g, b] = hslToRgb(h, 0.62, 0.42);
  const [r2, g2, b2] = hslToRgb(h, 0.7, 0.62);
  const png = new PNG({ width: SIZE, height: SIZE });
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = 236;
  const ring = 14;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      const idx = (y * SIZE + x) * 4;
      if (d <= R - ring) {
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
      } else if (d <= R) {
        png.data[idx] = r2;
        png.data[idx + 1] = g2;
        png.data[idx + 2] = b2;
        png.data[idx + 3] = 255;
      } else if (d <= R + 6) {
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
        png.data[idx + 3] = Math.round(255 * (1 - (d - R) / 6));
      }
    }
  }
  fs.writeFileSync(out, PNG.sync.write(png));
  made++;
}
console.log(`ikoner: ${made} skapade, ${skipped} fanns redan -> ${outDir}`);
