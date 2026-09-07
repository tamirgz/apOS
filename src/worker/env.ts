/**
 * Load .env.local BEFORE anything that reads process.env at module-load time.
 *
 * Why this is a separate module and not a `config()` call in index.ts: ES
 * modules hoist all `import`s above the body, so a `config()` statement in the
 * body runs AFTER every imported module has already evaluated — including
 * `@/core/db/client`, which snapshots DATABASE_URL and derives PG_SSL at import
 * time. That left the worker connecting to a cloud DB with the wrong (stale)
 * SSL setting → "no pg_hba.conf entry … no encryption". Putting the load in an
 * imported module makes it run at import-evaluation time, so importing THIS
 * first (before the db client) guarantees the env is present when the client
 * evaluates. dotenv never overrides an already-set process.env var, so a value
 * injected by launchd/systemd still wins.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
