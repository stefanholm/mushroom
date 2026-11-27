// Minimala typ-definitioner för Cloudflare-miljön (så worker/ går att tsc:a utan
// @cloudflare/workers-types). Endast det vi använder.
export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}
export interface R2BucketLike {
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: { key: string }[] }>;
}
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  // OBS: exec() finns medvetet INTE med i typningen — riktiga D1 kastar
  // "D1_EXEC_ERROR: ... incomplete input" på flerradiga multi-sats-strängar.
  // Kör alltid EN sats i taget via prepare().run() (se d1.ts ensureSchema).
}
export interface Env {
  TILES: R2BucketLike;
  DB: D1DatabaseLike;
  ORIGIN_URL?: string;
  DEFAULT_TILE_REV?: string; // aktiv revision (wrangler vars) — byt sist vid ny bake
  TILE_REV?: string; // bakåtkompat
  APP_ID?: string;
  FREE_HIDE_FRACTION?: string;
}
export interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}
