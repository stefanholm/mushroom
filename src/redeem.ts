// Inlösenkoder (redeem codes) — admin-utfärdade koder som låser upp all/pro/pack/arter.
// Delas av server.ts (POST /api/redeem) och scripts/redeem.mjs (admin-CLI).
// Koder och logg sparas i data/ (git-ignored) så de överlever omstarter men aldrig commitas.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIES, PACKS, SOLO_ONLY_SPECIES } from "./habitat.js";

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const CODES_FILE = path.join(DATA_DIR, "redeem-codes.json");
export const LOG_FILE = path.join(DATA_DIR, "redeem-log.json");

export interface RedeemCode {
  grant: string; // entitlement direkt: "all" | "pro" | "<packId>" | "species:<id>"
  uses: number; // max antal OLIKA enheter; 0 = obegränsat
  expires: string | null; // ISO YYYY-MM-DD
  note: string;
  createdAt: string;
  revoked: boolean;
  redeemedBy: string[]; // device ids
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // utan 0/O, 1/I/L — svårlästa tecken borttagna
function checksum(body: string): string {
  let s = 0;
  for (const c of body) s = (s + c.charCodeAt(0)) % ALPHABET.length;
  return ALPHABET[s];
}

export function makeCode(): string {
  const seg = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  const body = seg() + seg() + seg(); // 12 tecken
  return `SVAMP-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${checksum(body)}`;
}

// Tar emot "svamp-abcd-efgh-ijkm", "SVAMPABCDEFGHIJKM", "abcdefghijkm" etc.
export function normalizeCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^SVAMP/, "");
  if (c.length !== 13) return "";
  return `SVAMP-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}

export function checksumOk(code: string): boolean {
  const n = normalizeCode(code);
  if (!n) return false;
  const body = n.replace(/[^A-Z0-9]/g, "").slice(5); // efter "SVAMP"
  return checksum(body.slice(0, 12)) === body.slice(12);
}

export function validateGrant(grant: string): string | null {
  if (grant === "all" || grant === "pro") return null;
  if (grant.startsWith("species:")) {
    const id = grant.slice(8);
    if (!SPECIES[id]) return `Okänd art: ${id}`;
    if (SOLO_ONLY_SPECIES.includes(id)) return `${id} är solo-only — ge pack ${PACKS["goliatmusseron-solo"] ? "goliatmusseron-solo" : "<solo-pack>"} istället`;
    return null;
  }
  if (PACKS[grant]) return null;
  return `Okänt grant "${grant}" — använd all | pro | <packId> | species:<id>`;
}

export function grantLabel(grant: string): string {
  if (grant === "all") return "Alla arter";
  if (grant === "pro") return "Pro";
  if (grant.startsWith("species:")) return SPECIES[grant.slice(8)]?.label ?? grant;
  const p = PACKS[grant];
  return p ? `${p.label} (${p.species.length} arter)` : grant;
}

export function loadCodes(): Record<string, RedeemCode> {
  try {
    const j = JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));
    return j.codes ?? {};
  } catch {
    return {};
  }
}

export function saveCodes(codes: Record<string, RedeemCode>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CODES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ codes }, null, 2) + "\n");
  fs.renameSync(tmp, CODES_FILE);
}

export function appendLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}
