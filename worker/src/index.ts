// Svampradar edge-Worker (skelett, redo att `wrangler deploy`).
//
// Routing:
//   /api/tiles/<lager>/<z>/<x>/<y>.png  -> R2 key  tiles/<lager>/<z>/<x>_<y>.png   (immutable)
//   /icons/<fil>.png                    -> R2 key  icons/<fil>.png                 (immutable)
//   allt annat (/api/*, /, /vendor/*)   -> proxy till ORIGIN_URL (Node-servern)
//
// Syfte: telefonen hämtar stora PNG direkt från R2 nära användaren (snabb cold-start,
// 0 kr egress), och Node-originen exponeras aldrig publikt — bara Workern görs publik
// (se docs/IP-PROTECTION.md). Moln/regn-frames proxas fortfarande till origin men är
// redan `Cache-Control: immutable` där, så CDN-cachar dem på edge ändå.

interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}
interface R2BucketLike {
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectBodyLike | null>;
}
interface Env {
  TILES: R2BucketLike;
  ORIGIN_URL: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};
const IMMUTABLE = "public, max-age=31536000, immutable";

function contentTypeFor(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".js")) return "text/javascript";
  if (key.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

// /api/tiles/habitat/<art>/<z>/<x>/<y>.png -> tiles/habitat/<art>/<z>/<x>_<y>.png
function tileKey(pathname: string): string | null {
  const m = /^\/api\/tiles\/(.+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
  if (!m) return null;
  const key = `tiles/${m[1]}/${m[2]}_${m[3]}.png`;
  return key.includes("..") ? null : key;
}

async function serveFromR2(env: Env, key: string, cacheControl: string): Promise<Response> {
  const obj = await env.TILES.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": obj.httpMetadata?.contentType ?? contentTypeFor(key),
    "Cache-Control": obj.httpMetadata?.cacheControl ?? cacheControl,
    "Content-Length": String(obj.size),
    "Access-Control-Allow-Origin": "*", // tiles/ikoner är publika produkter
  };
  return new Response(obj.body, { status: 200, headers });
}

async function proxyToOrigin(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.ORIGIN_URL.replace(/\/$/, "");
  const target = `${origin}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  // Lägg på säkerhetsheaders även på proxyade svar (Node sätter sina egna också)
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.has(k)) out.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" || request.method === "HEAD") {
        const tk = tileKey(url.pathname);
        if (tk) return await serveFromR2(env, tk, IMMUTABLE);
        if (url.pathname.startsWith("/icons/")) {
          const key = url.pathname.slice(1);
          if (!key.includes("..")) return await serveFromR2(env, key, IMMUTABLE);
        }
      }
      return await proxyToOrigin(env, request);
    } catch (e) {
      return new Response(`edge error: ${(e as Error).message}`, { status: 502 });
    }
  },
};
