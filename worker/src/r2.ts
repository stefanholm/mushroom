// R2-hjälpare: prefix, immutable-headers, liten JSON-cache per isolate.
import type { Env, R2BucketLike } from "./cf-types.js";

export const R2_PREFIX_DEFAULT = "domains/fungi";

export function r2Prefix(env: Env): string {
  const rev = env.DEFAULT_TILE_REV ?? env.TILE_REV ?? "r15";
  return `${R2_PREFIX_DEFAULT}/${rev}`;
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export function contentTypeFor(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".jpg")) return "image/jpeg";
  return "application/octet-stream";
}

export async function getR2(env: Env, key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string; cacheControl: string } | null> {
  const obj = await env.TILES.get(key);
  if (!obj) return null;
  return {
    body: obj.body,
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? contentTypeFor(key),
    cacheControl: obj.httpMetadata?.cacheControl ?? IMMUTABLE,
  };
}

export function r2Response(o: { body: ReadableStream<Uint8Array>; size: number; contentType: string; cacheControl: string }, status = 200): Response {
  return new Response(o.body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": o.contentType,
      "Cache-Control": o.cacheControl,
      "Content-Length": String(o.size),
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const jsonCache = new Map<string, { at: number; value: unknown }>();
const JSON_TTL_MS = 60_000;
export async function getR2Json(env: Env, key: string, ttlMs = JSON_TTL_MS): Promise<unknown | null> {
  const c = jsonCache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.value;
  const o = await getR2(env, key);
  if (!o) return null;
  const text = await new Response(o.body).text();
  let value: unknown = null;
  try { value = JSON.parse(text); } catch { return null; }
  jsonCache.set(key, { at: Date.now(), value });
  return value;
}

export async function putR2Json(env: Env, key: string, value: unknown, cacheControl = "public, max-age=300"): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  await env.TILES.put(key, body.buffer as ArrayBuffer, { httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl } });
}
export async function putR2Png(env: Env, key: string, png: Uint8Array): Promise<void> {
  await env.TILES.put(key, png.buffer as ArrayBuffer, { httpMetadata: { contentType: "image/png", cacheControl: IMMUTABLE } });
}
const listCache = new Map<string, { at: number; keys: string[] }>();
const LIST_TTL_MS = 60_000; // hotspots listar upp till 20k block-nycklar per anrop — cacha listan kort
export async function listR2(env: Env, prefix: string, limit = 1000): Promise<string[]> {
  const ck = `${prefix}|${limit}`;
  const c = listCache.get(ck);
  if (c && Date.now() - c.at < LIST_TTL_MS) return c.keys;
  const res = await env.TILES.list({ prefix, limit });
  const keys = res.objects.map((o) => o.key);
  listCache.set(ck, { at: Date.now(), keys });
  return keys;
}
export type { R2BucketLike };
