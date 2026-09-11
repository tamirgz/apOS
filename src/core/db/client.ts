// Shared by the Next.js server AND the agent worker — do not import the
// `server-only` package here (it throws under plain Node/tsx).
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

// TLS policy, resolved once:
//  • local DB  → plaintext (dev container on localhost).
//  • cloud DB  → TLS. With AIOS_DB_CA_FILE set, verify the server's cert chain
//    AND hostname against that CA (verify-full) — protects against MITM, not
//    just passive snooping. Without a CA file, fall back to `require` (encrypt
//    only). A CA path that can't be read degrades to `require` with a warning
//    rather than hard-crashing the whole app on a missing file.
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
type SslPolicy = false | "require" | { ca: string; rejectUnauthorized: true };
function resolveSsl(): SslPolicy {
  if (isLocalDb) return false;
  const caFile = process.env.AIOS_DB_CA_FILE;
  if (!caFile) return "require";
  try {
    return { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true };
  } catch (e) {
    console.warn(
      `[db] AIOS_DB_CA_FILE set but unreadable (${caFile}): ${String(e)} — falling back to ssl:require (encrypted, unverified)`,
    );
    return "require";
  }
}
export const PG_SSL: SslPolicy = resolveSsl();

// Pool size. Default 10 is fine for a local Postgres (max_connections≈100), but
// a small hosted node has a tight cap (Aiven free = 20, shared across the web
// pool + worker pool + the worker's listener/lock + the SSE connection). Lower
// it via AIOS_PG_POOL_MAX on cloud so the two process pools + singletons fit.
const POOL_MAX = Math.max(1, Number(process.env.AIOS_PG_POOL_MAX ?? 10));

// On a hosted DB, connections are released after `idle_timeout` idle seconds.
// This must balance two costs on a REMOTE TLS DB:
//   - too SHORT and every navigation after a short pause pays a fresh connect +
//     TLS verify-full handshake to the DB region — measured ~600ms vs ~60ms on a
//     warm connection, which is exactly the "some pages take time" lag.
//   - too LONG (or 0 = never) and idle backends accumulate against the cap.
// The old 20s was sized for Aiven's dead 20-slot free cap; Supabase's pooler is
// 40, so we keep connections WARM across an active browsing session (default
// 10 min, tunable via AIOS_PG_IDLE_TIMEOUT) and let max_lifetime recycle them
// for hygiene. Locally it's a harmless no-op (unlimited connections).
// idle_timeout/max_lifetime are in SECONDS.
const IDLE_TIMEOUT = Math.max(20, Number(process.env.AIOS_PG_IDLE_TIMEOUT ?? 600));
const idleOpts =
  PG_SSL === false
    ? {}
    : { idle_timeout: IDLE_TIMEOUT, max_lifetime: 60 * 30, connect_timeout: 30 };

// Cache the connection across Next.js HMR reloads.
const g = globalThis as unknown as { __aiosSql?: ReturnType<typeof postgres> };

export const sql =
  g.__aiosSql ?? postgres(url, { max: POOL_MAX, ssl: PG_SSL, ...idleOpts });
if (process.env.NODE_ENV !== "production") g.__aiosSql = sql;

export const db = drizzle(sql);
export type Db = typeof db;
