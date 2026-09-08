import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Core schema + every module's schema fragment compose into one migration stream.
  schema: ["./src/core/db/schema/*.ts", "./src/modules/*/schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios",
    // A hosted DB (Supabase/Aiven) enforces TLS; the raw URL has no sslmode, so
    // migrations would fail without this. Local (localhost) doesn't use it.
    ssl: /@(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL ?? "")
      ? false
      : "require",
  },
});
