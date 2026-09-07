// Shared by the Next.js server AND the agent worker — do not import the
// `server-only` package here (it throws under plain Node/tsx).
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

// A local DB speaks plaintext; a hosted one (Aiven/Supabase/etc.) requires TLS.
// Auto-detect from the host so the same code serves both without a flag — the
// dev container stays plaintext, a cloud URL gets `ssl: "require"` (TLS without
// CA verification, i.e. sslmode=require — no CA file needed).
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
export const PG_SSL: false | "require" = isLocalDb ? false : "require";

// Pool size. Default 10 is fine for a local Postgres (max_connections≈100), but
// a small hosted node has a tight cap (Aiven free = 20, shared across the web
// pool + worker pool + the worker's listener/lock + the SSE connection). Lower
// it via AIOS_PG_POOL_MAX on cloud so the two process pools + singletons fit.
const POOL_MAX = Math.max(1, Number(process.env.AIOS_PG_POOL_MAX ?? 10));

// Cache the connection across Next.js HMR reloads.
const g = globalThis as unknown as { __aiosSql?: ReturnType<typeof postgres> };

export const sql = g.__aiosSql ?? postgres(url, { max: POOL_MAX, ssl: PG_SSL });
if (process.env.NODE_ENV !== "production") g.__aiosSql = sql;

export const db = drizzle(sql);
export type Db = typeof db;
