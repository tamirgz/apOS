/**
 * `pnpm db:migrate` — apply pending SQL migrations in ./drizzle.
 *
 * Replaces `drizzle-kit migrate`, which on this toolchain (Node 26) exits 1 on
 * every run — even with nothing pending — after printing only a spinner. The
 * deploy script treated that as a soft warning, so migrations were silently
 * skipped on push. drizzle-orm's own migrator reads the same journal and
 * `drizzle.__drizzle_migrations` table, so this is a drop-in replacement.
 */
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

config({ path: ".env.local", quiet: true });
const url = process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";
// Same TLS rule as drizzle.config.ts: hosted DBs enforce TLS, localhost doesn't.
const ssl = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url) ? false : "require";

const client = postgres(url, { max: 1, ssl, onnotice: () => {} });
try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  console.log("migrations applied");
} catch (e) {
  const err = e as { message?: string; cause?: { message?: string } };
  console.error("migration failed:", err.cause?.message ?? err.message ?? e);
  process.exitCode = 1;
} finally {
  await client.end();
}
