// Admin-CLI för inlösenkoder (redeem codes).
//
//   npm run redeem -- create --grant blandad-korg-1 --uses 5 --note "kompis" --expires 2027-06-30
//   npm run redeem -- create --grant all --uses 1 --note "support ärende #123"
//   npm run redeem -- create --grant species:bjorksopp --uses 0
//   npm run redeem -- list
//   npm run redeem -- show SVAMP-XXXX-XXXX-XXXX
//   npm run redeem -- revoke SVAMP-XXXX-XXXX-XXXX
//
// grant = "all" | "pro" | "<packId>" (t.ex. blandad-korg-1, goliatmusseron-solo) | "species:<id>"
// uses  = max antal olika enheter (0 = obegränsat). expires = YYYY-MM-DD (valfritt).
// Koder sparas i data/redeem-codes.json (git-ignored) — backa upp filen vid behov.
import { makeCode, normalizeCode, validateGrant, grantLabel, loadCodes, saveCodes, CODES_FILE } from "../src/redeem.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "list";
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};

if (cmd === "create") {
  const grant = String(opt("grant", ""));
  const err = validateGrant(grant);
  if (err) {
    console.error("FEL: " + err);
    process.exit(1);
  }
  const uses = Number(opt("uses", "1"));
  const expires = opt("expires", "") || null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    console.error("FEL: --expires ska vara YYYY-MM-DD");
    process.exit(1);
  }
  const note = String(opt("note", ""));
  const code = makeCode();
  const codes = loadCodes();
  codes[code] = { grant, uses, expires, note, createdAt: new Date().toISOString(), revoked: false, redeemedBy: [] };
  saveCodes(codes);
  console.log(`Skapad kod: ${code}`);
  console.log(`  ger: ${grantLabel(grant)} (entitlement "${grant}")`);
  console.log(`  uses: ${uses === 0 ? "obegränsat" : uses}, expires: ${expires ?? "aldrig"}, note: ${note || "-"}`);
  console.log(`  fil: ${CODES_FILE}`);
} else if (cmd === "list") {
  const codes = loadCodes();
  const rows = Object.entries(codes).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  if (rows.length === 0) console.log("Inga koder än. Skapa med: npm run redeem -- create --grant <grant> --uses <n>");
  for (const [code, e] of rows) {
    console.log(
      `${code}  ${e.revoked ? "ÅTERKALLAD " : e.expires && e.expires < new Date().toISOString().slice(0, 10) ? "UTGÅNGEN  " : "aktiv     "}` +
        ` grant=${e.grant} (${grantLabel(e.grant)}) uses=${e.uses === 0 ? "∞" : `${e.redeemedBy.length}/${e.uses}`} expires=${e.expires ?? "-"} note=${e.note || "-"}`,
    );
  }
} else if (cmd === "show") {
  const code = normalizeCode(args[1] ?? "");
  const e = loadCodes()[code];
  if (!e) {
    console.error("Hittades inte: " + (args[1] ?? ""));
    process.exit(1);
  }
  console.log(code, JSON.stringify(e, null, 2));
} else if (cmd === "revoke") {
  const code = normalizeCode(args[1] ?? "");
  const codes = loadCodes();
  const e = codes[code];
  if (!e) {
    console.error("Hittades inte: " + (args[1] ?? ""));
    process.exit(1);
  }
  e.revoked = true;
  saveCodes(codes);
  console.log(`Återkallad: ${code}`);
} else {
  console.log("Användning: npm run redeem -- create|list|show|revoke ...");
  process.exit(1);
}
