import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// "nvidia" = free-tier NVIDIA cloud (OpenAI-compatible). Guarded so only $0
// models can run — see src/core/ai/nvidia.ts. "mlx" = local Apple-MLX runtime
// via mlx_lm.server. Text column, so adding a provider needs no migration.
export const AI_PROVIDERS = ["anthropic", "ollama", "mlx", "nvidia", "gemini", "openrouter", "tokenharbor"] as const;
export type AIProviderId = (typeof AI_PROVIDERS)[number];

/**
 * "Cloud" vs "local" classification, used anywhere the UI shows a C/L badge
 * (per-agent model picker, Agents usage panel). Kept in this schema file
 * (rather than core/ai/routing.ts) so CLIENT components can import it without
 * pulling in the Anthropic/Ollama provider SDKs that routing.ts wires up —
 * one of those (@anthropic-ai/claude-agent-sdk) needs Node's `async_hooks`
 * and breaks the browser bundle if a "use client" file imports it.
 */
export const CLOUD_PROVIDERS: readonly AIProviderId[] = [
  "anthropic",
  "nvidia",
  "gemini",
  "openrouter",
  "tokenharbor",
];
export function isCloudProvider(p: AIProviderId): boolean {
  return CLOUD_PROVIDERS.includes(p);
}

/**
 * Provider/model routing table. Keys: "chat", "agent.default", "agent:<uuid>".
 * Resolution order: exact key → "agent.default" → "chat".
 */
export const aiRoutes = pgTable("ai_routes", {
  taskKey: text("task_key").primaryKey(),
  provider: text("provider", { enum: AI_PROVIDERS }).notNull(),
  model: text("model").notNull(),
  options: jsonb("options"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AiRoute = typeof aiRoutes.$inferSelect;
