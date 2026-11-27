// Svampradar edge-Worker — origin-fri variant (R2 + D1 + SMHI-cron).
//
// Statiskt från R2 (immutable): tiles, ikoner, manifest.json, overview-JSON,
// 10x10 km hotspot-block, väder-frames/manifest, zones (förbakade optimalzoner).
// D1: signaler, topplista, privacy-delete, ents (per device, app_id satt).
// `/api/hotspots`, `/api/v1/fungi/overview`, `/api/v1/bootstrap`, `/api/shop`,
// `/api/unlocked` byggs i Workern från R2+D1 (live-faktor från weather/live.json).
// `/api/v1/fungi/optimal-zone` serveras från förbakade zones/<art>-<date>-<s>.json
// (bakas av origin/Macen — rasters finns aldrig i molnet, se docs/IP-PROTECTION.md).
// Allt annat proxas till ORIGIN_URL om satt (dev), annars 404.
//
// R2-layout (bucket svampradar-tiles):  domains/fungi/<TILE_REV>/...  +  promo/family.json
import { getR2, getR2Json, r2Response, r2Prefix, putR2Json, IMMUTABLE, SECURITY_HEADERS, contentTypeFor, listR2 } from "./r2.js";
import { toSWEREF } from "./sweref.js";
import { encodePng } from "./png.js";
import { bakeWeatherCron, getLiveFactor } from "./smhi.js";
import { reportSignal, leaderboard, myScore, deleteDevice, resolveEnts, setEnts, getEnts } from "./d1.js";
import type { Env, ExecutionContextLike } from "./cf-types.js";

const SWEDEN = { minLon: 10.5, minLat: 55.0, maxLon: 24.5, maxLat: 69.5 };
const BLOCK_M = 10000;
const MACRO_SPAN = 1.5;
const MAXP_MACRO = 180;

interface CatalogSpecies { id: string; label: string; season: [number, number]; pack: string | null; protected: boolean; rainWindowDays: number; }
interface Catalog {
  freeSpecies: string[];
  klassiker: string[];
  packs: { id: string; label: string; priceSek: number; species: string[] }[];
  species: CatalogSpecies[];
}
interface BlockFile { art: string; bx: number; by: number; pins: { lon: number; lat: number; s: number }[] }
interface OverviewFile { cells: { e: number; n: number; lon: number; lat: number; max: number }[] }
interface ZoneFile { [k: string]: unknown }

async function catalog(env: Env): Promise<Catalog | null> {
  return (await getR2Json(env, `${r2Prefix(env)}/catalog.json`, 5 * 60_000)) as Catalog | null;
}

// Enkel unlock-logik portad från src/habitat.ts (klassiker vid årskort/pro, annars pack/all/species:/reward:)
function unlockedIds(cat: Catalog, ents: Set<string>): Set<string> {
  const out = new Set<string>();
  const klassikerActive = ents.has("pro") || ents.has("topspots") || [...ents].some((e) => e.startsWith("topspots:"));
  for (const sp of cat.species) {
    if (cat.freeSpecies.includes(sp.id)) { out.add(sp.id); continue; }
    if (klassikerActive && cat.klassiker.includes(sp.id)) { out.add(sp.id); continue; }
    if (ents.has("all")) { out.add(sp.id); continue; }
    if (sp.pack && ents.has(sp.pack)) { out.add(sp.id); continue; }
    if ([...ents].some((e) => e.startsWith("reward:") || e.startsWith("species:"))) {
      const claimed = [...ents].filter((e) => e.startsWith("species:")).map((e) => e.slice(8));
      if (claimed.includes(sp.id)) out.add(sp.id);
    }
  }
  return out;
}
const canSeeTopSpots = (ents: Set<string>) =>
  ents.has("pro") || ents.has("topspots") || [...ents].some((e) => e.startsWith("topspots:"));
const isTrial = (url: URL, ents: Set<string>) => url.searchParams.get("trial") === "1" || ents.has("trial");
const freeHideFraction = (env: Env) => Math.max(0, Math.min(0.95, Number(env.FREE_HIDE_FRACTION ?? 0.3) || 0.3));

function applyGoldCap<T extends { score: number; species: string }>(
  pins: T[], ents: Set<string>, url: URL, env: Env,
): { pins: (T & { gold?: boolean })[]; capped: boolean; goldPeaks: number } {
  const paid = canSeeTopSpots(ents);
  const trial = isTrial(url, ents);
  const capped = !paid && !trial;
  const frac = freeHideFraction(env);
  const bySpecies = new Map<string, T[]>();
  for (const p of pins) {
    const arr = bySpecies.get(p.species) ?? [];
    arr.push(p); bySpecies.set(p.species, arr);
  }
  const out: (T & { gold?: boolean })[] = [];
  let goldPeaks = 0;
  for (const arr of bySpecies.values()) {
    arr.sort((a, b) => b.score - a.score);
    const hide = capped ? Math.floor(arr.length * frac) : 0;
    const kept = capped ? arr.slice(Math.max(1, hide)) : arr; // minst 1 pin per art vid cap
    for (let i = 0; i < kept.length; i++) {
      const g = paid && i < Math.ceil(kept.length * frac);
      if (g) goldPeaks++;
      out.push({ ...kept[i], gold: g || undefined });
    }
  }
  return { pins: out, capped, goldPeaks };
}

// ---------- /api/hotspots från R2-block ----------
async function hotspotsFromR2(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const ents = new Set(await resolveEnts(req, env));
  const cat = await catalog(env);
  const keys = (url.searchParams.get("species") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0 || !cat) return null; // låt origin hantera om ingen katalog
  const openAll = keys.filter((k) => cat.species.some((s) => s.id === k));
  const unlocked = unlockedIds(cat, ents);
  const locked = openAll.filter((k) => !unlocked.has(k));
  const open = openAll.filter((k) => unlocked.has(k));
  if (open.length === 0 && locked.length > 0) {
    return Response.json({ error: "Låst innehåll — köp svamppack eller Pro i appen.", locked }, { status: 403 });
  }
  const bboxParam = url.searchParams.get("bbox");
  const box = bboxParam ? bboxParam.split(",").map(Number) : null;
  if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return Response.json({ error: "Expected bbox=minLon,minLat,maxLon,maxLat" }, { status: 400 });
  }
  let [minLon, minLat, maxLon, maxLat] = box;
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  minLon = Math.max(minLon, SWEDEN.minLon); maxLon = Math.min(maxLon, SWEDEN.maxLon);
  minLat = Math.max(minLat, SWEDEN.minLat); maxLat = Math.min(maxLat, SWEDEN.maxLat);
  const staticOnly = url.searchParams.get("static") === "1";
  const minScore = Math.max(0, Math.min(100, Number(url.searchParams.get("minScore") ?? 50) || 50));
  const maxP = Math.max(1, Math.min(MAXP_MACRO, Number(url.searchParams.get("maxP") ?? MAXP_MACRO) || MAXP_MACRO));

  const [minE, maxN] = toSWEREF(minLon, maxLat);
  const [maxE, minN] = toSWEREF(maxLon, minLat);
  // block-nycklar är i meter (hela 10 km-tusental), samma som bake-skriptet skriver
  const bx0 = Math.floor(minE / BLOCK_M) * BLOCK_M, bx1 = Math.ceil(maxE / BLOCK_M) * BLOCK_M;
  const by0 = Math.floor(minN / BLOCK_M) * BLOCK_M, by1 = Math.ceil(maxN / BLOCK_M) * BLOCK_M;
  const prefix = r2Prefix(env);

  const all: { lon: number; lat: number; score: number; species: string }[] = [];
  for (const sp of open) {
    const keys_ = await listR2(env, `${prefix}/hotspots/${sp}/`, 20000);
    for (const key of keys_) {
      const m = /\/(\d+)_(\d+)\.json$/.exec(key);
      if (!m) continue;
      const bxe = Number(m[1]), byn = Number(m[2]);
      if (bxe < bx0 - BLOCK_M || bxe > bx1 + BLOCK_M || byn < by0 - BLOCK_M || byn > by1 + BLOCK_M) continue;
      const bf = (await getR2Json(env, key, 10 * 60_000)) as BlockFile | null;
      if (!bf?.pins) continue;
      for (const p of bf.pins) {
        if (p.lon < minLon || p.lon > maxLon || p.lat < minLat || p.lat > maxLat) continue;
        let score = p.s;
        if (!staticOnly) score = Math.min(100, Math.round(score * (await getLiveFactor(env, p.lat, p.lon))));
        if (score >= minScore) all.push({ lon: p.lon, lat: p.lat, score, species: sp });
      }
    }
  }
  all.sort((a, b) => b.score - a.score);
  // rättvis kvot: minst floor(maxP/keys) per art först, sedan resten efter score
  const quota = Math.floor(maxP / Math.max(1, open.length));
  const perSpecies = new Map<string, typeof all>();
  for (const p of all) {
    const arr = perSpecies.get(p.species) ?? [];
    arr.push(p); perSpecies.set(p.species, arr);
  }
  const picked: typeof all = [];
  const pickedSet = new Set<(typeof all)[number]>();
  for (const [, arr] of perSpecies) {
    for (const p of arr.slice(0, quota)) { picked.push(p); pickedSet.add(p); }
  }
  for (const p of all) if (!pickedSet.has(p) && picked.length < maxP) { picked.push(p); pickedSet.add(p); }
  const { pins, capped, goldPeaks } = applyGoldCap(picked, ents, url, env);
  return Response.json({
    hotspots: pins,
    skipped: locked,
    meta: {
      source: "r2-blocks",
      capped, goldPeaks,
      topHiddenFraction: freeHideFraction(env),
      trial: isTrial(url, ents),
      asOf: new Date().toISOString().slice(0, 10),
    },
  }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
}

// ---------- /api/v1/fungi/overview från R2 ----------
async function overviewFromR2(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const ents = new Set(await resolveEnts(req, env));
  const cat = await catalog(env);
  const keys = (url.searchParams.get("species") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0 || !cat) return null;
  const unlocked = unlockedIds(cat, ents);
  const locked = keys.filter((k) => cat.species.some((s) => s.id === k) && !unlocked.has(k));
  const open = keys.filter((k) => unlocked.has(k));
  if (open.length === 0 && locked.length > 0) {
    return Response.json({ error: "Låst innehåll.", locked }, { status: 403 });
  }
  const staticOnly = url.searchParams.get("static") === "1";
  const minScore = Math.max(0, Math.min(100, Number(url.searchParams.get("minScore") ?? 55) || 55));
  const prefix = r2Prefix(env);
  const profile = (await getR2Json(env, `${prefix}/overview/species-pyramid-profile.json`, 10 * 60_000)) as {
    profiles?: Record<string, unknown>;
  } | null;
  const profiles: Record<string, unknown> = {};
  const tiers: Record<string, unknown[]> = { "55km": [], "18km": [], "6km": [] };
  const TIER_SIZES: [string, number][] = [["55km", 55000], ["18km", 18000], ["6km", 6000]];
  for (const sp of open) {
    const ov = (await getR2Json(env, `${prefix}/overview/${sp}.json`, 10 * 60_000)) as OverviewFile | null;
    if (!ov?.cells) continue;
    profiles[sp] = profile?.profiles?.[sp] ?? null;
    const tierMaps = new Map<string, Map<string, { species: string; lat: number; lon: number; score: number; count: number; gold: boolean }>>();
    for (const [label] of TIER_SIZES) tierMaps.set(label, new Map());
    for (const c of ov.cells) {
      let score = c.max;
      if (!staticOnly) score = Math.min(100, Math.round(score * (await getLiveFactor(env, c.lat, c.lon))));
      if (score < minScore) continue;
      for (const [label, size] of TIER_SIZES) {
        const m = tierMaps.get(label)!;
        const k = `${Math.floor(c.e / size)},${Math.floor(c.n / size)}`;
        const prev = m.get(k);
        if (!prev || score > prev.score) m.set(k, { species: sp, lat: c.lat, lon: c.lon, score, count: 1, gold: false });
      }
    }
    for (const [label, m] of tierMaps) {
      const arr = [...m.values()].sort((a, b) => b.score - a.score);
      const paid = canSeeTopSpots(ents);
      const frac = freeHideFraction(env);
      const hide = (!paid && !isTrial(url, ents)) ? Math.floor(arr.length * frac) : 0;
      arr.forEach((c, i) => {
        if (i < Math.max(1, hide) && hide > 0 && !paid) return; // dölj topp-fraktion för free
        tiers[label].push({ ...c, gold: paid && i < Math.ceil(arr.length * frac) });
      });
    }
  }
  return Response.json({
    overviewRevision: new Date().toISOString(),
    mode: staticOnly ? "habitat" : "live",
    capped: !canSeeTopSpots(ents) && !isTrial(url, ents),
    trial: isTrial(url, ents),
    skipped: locked,
    profiles,
    tiers,
  }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
}

// ---------- proxy-fallback ----------
async function proxyOrigin(req: Request, env: Env): Promise<Response> {
  if (!env.ORIGIN_URL) return Response.json({ error: "not found (origin ej satt)" }, { status: 404 });
  const url = new URL(req.url);
  const target = env.ORIGIN_URL.replace(/\/$/, "") + url.pathname + url.search;
  const headers = new Headers(req.headers);
  headers.set("x-forwarded-host", url.host);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.has(k)) out.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

// ---------- router ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      // --- statiskt från R2 ---
      if (request.method === "GET" || request.method === "HEAD") {
        const tile = /^\/api\/tiles\/(.+)\/(\d+)\/(\d+)\.png$/.exec(p);
        if (tile) {
          const key = `${r2Prefix(env)}/tiles/${tile[1]}/${tile[2]}_${tile[3]}.png`;
          if (!key.includes("..")) {
            const o = await getR2(env, key);
            if (o) return r2Response(o);
            return await proxyOrigin(request, env); // on-demand-bakning bor kvar på origin i dev
          }
        }
        if (p.startsWith("/icons/")) {
          const key = `${r2Prefix(env)}/${p.slice(1)}`;
          if (!key.includes("..")) {
            const o = await getR2(env, key);
            if (o) return r2Response(o);
          }
        }
        if (p === "/manifest.json" || p === "/api/v1/manifest") {
          const o = await getR2(env, `${r2Prefix(env)}/manifest.json`);
          if (o) return r2Response(o, 200);
          return Response.json(
            { api: "v1", tileRev: env.TILE_REV ?? "r16", generatedAt: new Date().toISOString(), bounds: [SWEDEN.minLon, SWEDEN.minLat, SWEDEN.maxLon, SWEDEN.maxLat] },
            { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=300" } },
          );
        }
        if (p === "/promo/family.json") {
          const o = await getR2(env, "promo/family.json");
          if (o) return r2Response(o);
        }
        // väder-manifest + frames från R2
        if (p === "/api/v1/weather/clouds/manifest") {
          const o = await getR2(env, `${r2Prefix(env)}/frames/clouds/manifest.json`);
          if (o) return r2Response({ ...o, cacheControl: "public, max-age=300" });
        }
        const cloudFrame = /^\/api\/v1\/weather\/clouds\/frame\/(.+)\.png$/.exec(p);
        if (cloudFrame) {
          const o = await getR2(env, `${r2Prefix(env)}/frames/clouds/${cloudFrame[1]}.png`);
          if (o) return r2Response(o);
        }
        if (p === "/api/v1/weather/rain-history/manifest") {
          const days = (url.searchParams.get("days") ?? "28");
          const o = await getR2(env, `${r2Prefix(env)}/frames/rain/manifest-${days}d.json`);
          if (o) return r2Response({ ...o, cacheControl: "public, max-age=600" });
        }
        const rainFrame = /^\/api\/v1\/weather\/rain-history\/frame\/(.+)\.png$/.exec(p);
        if (rainFrame) {
          const id = rainFrame[1];
          for (const d of ["42", "28", "21", "14"]) {
            const o = await getR2(env, `${r2Prefix(env)}/frames/rain/${d}d/${id}.png`);
            if (o) return r2Response(o);
          }
        }
        // --- API byggt i Workern ---
        if (p === "/api/hotspots") {
          const r = await hotspotsFromR2(request, env);
          if (r) return r;
        }
        if (p === "/api/v1/fungi/overview" || p === "/api/overview") {
          const r = await overviewFromR2(request, env);
          if (r) return r;
        }
        if (p === "/api/v1/fungi/optimal-zone") {
          // förbakade zoner: zones/<art>-<date>-<static>.json (bakas av origin/Mac)
          const sp = (url.searchParams.get("species") ?? "").split(",")[0]?.trim();
          const date = (url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10));
          const st = url.searchParams.get("static") === "1" ? "1" : "0";
          if (sp && !sp.includes("/") && !sp.includes("..")) {
            const o = await getR2(env, `${r2Prefix(env)}/zones/${sp}-${date}-${st}.json`);
            if (o) {
              const body = await new Response(o.body).json();
              return Response.json({ ...(body as object), cached: true, asOf: date }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60" } });
            }
          }
        }
        if (p === "/api/v1/bootstrap" || p === "/api/bootstrap") {
          return await bootstrapWorker(request, env);
        }
        if (p === "/api/shop" || p === "/api/unlocked") {
          const ents = new Set(await resolveEnts(request, env));
          const cat = await catalog(env);
          if (cat) {
            const unlocked = unlockedIds(cat, ents);
            if (p === "/api/unlocked") {
              return Response.json({
                entitlements: [...ents],
                unlocked: [...unlocked],
                svenskaKlassiker: cat.klassiker,
                svenskaKlassikerActive: canSeeTopSpots(ents),
                topSpots: canSeeTopSpots(ents),
              }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60" } });
            }
            const shop = (await getR2Json(env, `${r2Prefix(env)}/shop.json`, 10 * 60_000)) as Record<string, unknown> | null;
            if (shop) {
              const owned = (id: string) => ents.has("all") || (cat.species.find((s) => s.id === id)?.pack != null && ents.has(cat.species.find((s) => s.id === id)!.pack!));
              const out = { ...shop };
              if (Array.isArray(out.singles)) out.singles = out.singles.filter((s) => !(s as { id: string }).id || !owned((s as { id: string }).id));
              return Response.json(out, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=300" } });
            }
          }
        }
        if (p === "/api/leaderboard") return await leaderboard(request, env);
        if (p === "/api/leaderboard/score") return await myScore(request, env);
      }
      if (request.method === "POST" && p === "/api/report-signal") return await reportSignal(request, env);
      if (request.method === "DELETE" && p === "/api/privacy/delete") return await deleteDevice(request, env);
      if (request.method === "POST" && p === "/api/verify-receipt") {
        // DEV: lagra ents per device. PROD: ersätt med App Store Server API (JWS ES256,
        // .p8 som Worker-secret) — se worker/README.md och docs/PROD-READINESS.md.
        const body = await request.json().catch(() => null) as { device?: string; ents?: string[] } | null;
        if (!body?.device || !Array.isArray(body.ents)) return Response.json({ error: "device+ents krävs (dev)" }, { status: 400 });
        await setEnts(env, body.device, body.ents);
        return Response.json({ ok: true, entitlements: body.ents });
      }
      // chat, redeem, reward, admin, debug, tiles-on-demand, optimal-zone live, övrig webb → origin
      return await proxyOrigin(request, env);
    } catch (e) {
      return Response.json({ error: "edge error", detail: (e as Error).message }, { status: 502 });
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    // SMHI-cron: baka moln/regn-frames + live.json till R2 (kan behöva Workers Paid >10 ms CPU)
    ctx.waitUntil(
      bakeWeatherCron(env)
        .then((r) => console.log(`cron bake klar: ${JSON.stringify(r)}`))
        .catch((e) => console.error("cron bake misslyckades:", (e as Error).message)),
    );
  },
};

// ---------- bootstrap i Workern (samma kontrakt som Node) ----------
async function bootstrapWorker(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ents = new Set(await resolveEnts(req, env));
  const cat = await catalog(env);
  const prefix = r2Prefix(env);
  const manifest = (await getR2Json(env, `${prefix}/manifest.json`, 5 * 60_000)) as Record<string, unknown> | null;
  const shop = (await getR2Json(env, `${prefix}/shop.json`, 10 * 60_000)) as Record<string, unknown> | null;
  const clouds = await getR2Json(env, `${prefix}/frames/clouds/manifest.json`, 5 * 60_000);
  const rainHistory: Record<string, unknown> = {};
  for (const d of ["14", "21", "28", "42"]) rainHistory[d] = await getR2Json(env, `${prefix}/frames/rain/manifest-${d}d.json`, 5 * 60_000);
  let leaderboardRes: unknown = null;
  try { leaderboardRes = await leaderboard(req, env); } catch { /* D1 kan saknas i dev */ }
  const unlocked = cat ? [...unlockedIds(cat, ents)] : [];
  // per-art-bundle för ?species=
  const want = (url.searchParams.get("species") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const fungi: Record<string, unknown> = {};
  if (cat) {
    const profile = (await getR2Json(env, `${prefix}/overview/species-pyramid-profile.json`, 10 * 60_000)) as { profiles?: Record<string, unknown> } | null;
    const unlockedSet = new Set(unlocked);
    const lockedF: string[] = [];
    for (const id of want) {
      const sp = cat.species.find((s) => s.id === id);
      if (!sp) continue;
      if (!unlockedSet.has(id)) { lockedF.push(id); continue; }
      const ov = (await getR2Json(env, `${prefix}/overview/${id}.json`, 10 * 60_000)) as OverviewFile | null;
      const cells = (ov?.cells ?? []).slice().sort((a, b) => b.max - a.max).slice(0, 120)
        .map((c) => ({ lon: c.lon, lat: c.lat, score: Math.round(c.max), e: Math.round(c.e), n: Math.round(c.n) }));
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      const st = url.searchParams.get("static") === "1" ? "1" : "0";
      const zone = (await getR2Json(env, `${prefix}/zones/${id}-${date}-${st}.json`, 60_000)) as ZoneFile | null;
      fungi[id] = {
        label: sp.label, season: sp.season, rainWindowDays: sp.rainWindowDays, pack: sp.pack, protected: sp.protected,
        profile: profile?.profiles?.[id] ?? null,
        overviewCells: cells,
        zone, zonePending: zone ? false : true,
      };
    }
    return Response.json({
      api: "v1",
      tileRev: manifest?.tileRev ?? env.TILE_REV ?? "r16",
      serverTime: new Date().toISOString(),
      asOf: new Date().toISOString().slice(0, 10),
      shop,
      unlocked: { entitlements: [...ents], unlocked, svenskaKlassiker: cat.klassiker, svenskaKlassikerActive: canSeeTopSpots(ents), topSpots: canSeeTopSpots(ents) },
      leaderboard: leaderboardRes,
      clouds,
      rainHistory,
      fungi: want.length > 0 ? fungi : undefined,
      skippedSpecies: lockedF.length > 0 ? lockedF : undefined,
    }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
  }
  // utan katalog: bara manifest-bas
  return Response.json({
    api: "v1", tileRev: manifest?.tileRev ?? env.TILE_REV ?? "r16",
    serverTime: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10),
    clouds, rainHistory,
  }, { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=60" } });
}

// re-export för test-harness
export { encodePng, putR2Json, getLiveFactor };
