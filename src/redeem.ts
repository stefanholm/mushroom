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

// grant kan vara flera entitlements kommaseparerade: "blandad-korg-1,blandad-korg-2" eller "species:bjorksopp,all"
export function validateGrant(grant: string): string | null {
  const parts = grant.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "Tomt grant";
  if (parts.length > 1 && (parts.includes("all") || parts.includes("pro"))) return "all/pro kan inte kombineras med annat";
  for (const g of parts) {
    const err = validateOneGrant(g);
    if (err) return err;
  }
  return null;
}

function validateOneGrant(g: string): string | null {
  if (g === "all" || g === "pro") return null;
  if (g === "topspots" || /^topspots:\d{4}$/.test(g)) return null; // årskort för hetaste ställena
  if (g.startsWith("species:")) {
    const id = g.slice(8);
    if (!SPECIES[id]) return `Okänd art: ${id}`;
    if (SOLO_ONLY_SPECIES.includes(id)) return `${id} är solo-only — ge pack goliatmusseron-solo istället`;
    return null;
  }
  if ((PACKS as Record<string, unknown>)[g]) return null;
  return `Okänt grant "${g}" — använd all | pro | <packId> | species:<id>`;
}

export function grantLabel(grant: string): string {
  const parts = grant.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.map(oneLabel).join(" + ");
}

function oneLabel(g: string): string {
  if (g === "all") return "Alla arter";
  if (g === "pro") return "Pro";
  if (g === "topspots") return "Topspots (hetaste ställena, alla år)";
  if (/^topspots:\d{4}$/.test(g)) return `Årskort ${g.slice(9)} (hetaste ställena)`;
  if (g.startsWith("species:")) return SPECIES[g.slice(8)]?.label ?? g;
  const p = (PACKS as Record<string, { label: string; species: string[] }>)[g];
  return p ? `${p.label} (${p.species.length} arter)` : g;
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
