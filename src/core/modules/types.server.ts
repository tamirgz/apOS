// Server-side module contract: components, DB schema, AI tools, agent
// templates. Imported only from server components and the agent worker —
// never from client components. (Enforced by convention, not the
// `server-only` package, because the worker runs under plain Node/tsx.)
import type { ComponentType } from "react";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ZodType } from "zod";
import type { Db } from "@/core/db/client";

/**
 * A backbone-BOUND subject for an agent run. The association (which entity a
 * write lands on) is well-defined and static, so it is NEVER left to the model:
 * a cursor tool (e.g. projects.focusNext) sets this, and per-subject write tools
 * target `id` from here — the model produces only content, never an id. This is
 * what makes a judgement structurally unable to land on the wrong entity.
 */
export interface FocusSubject {
  /** Entity kind — "project" today; extensible to tasks/people/ideas. */
  kind: string;
  id: string;
  name: string;
}

export interface AiToolContext {
  db: Db;
  /** Set when the tool is invoked from an agent run (not chat). */
  agentRunId?: string;
  /** Processed-items ledger, available to agent runs for idempotency. */
  ledger?: {
    has(itemKey: string): Promise<boolean>;
    mark(itemKey: string, result?: unknown): Promise<void>;
  };
  /**
   * The currently-focused subject. Per-subject write tools target THIS instead
   * of a model-supplied id (see FocusSubject). Null in chat / when unfocused.
   * Mutable across a run: the same ctx object is threaded to every tool call,
   * so a cursor tool sets it and later writes read it.
   */
  subject?: FocusSubject | null;
  /**
   * Internal per-run state backing the focusNext cursor. The backbone owns the
   * subject SET and its ORDER, so the model iterates without ever selecting an
   * entity. Built lazily on the first focusNext call.
   */
  subjectCursor?: {
    kind: string;
    items: Array<{ id: string; name: string; read: Record<string, unknown> }>;
    index: number;
  } | null;
  /**
   * Per-run entity handle table for SURVEY writes (where the agent legitimately
   * picks WHICH few entities to act on — task triage, idea review, follow-ups).
   * A `*.list` tool registers each row under a short, non-UUID handle (t1, i2,
   * p3…); the matching write tool resolves the handle back to the real id,
   * validated against what was actually listed. The model copies a 2-char
   * handle, never a UUID — so it cannot mis-transcribe onto the wrong entity,
   * and an unknown handle errors instead of silently mis-filing.
   */
  refs?: Record<string, { kind: string; id: string; name: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AiToolDef<I = any> {
  /** Namespaced: "<module>.<action>", e.g. "tasks.create". */
  name: string;
  description: string;
  input: ZodType<I>;
  execute(input: I, ctx: AiToolContext): Promise<unknown>;
  /**
   * "safe" (default): executes immediately everywhere.
   * "approval": in unattended AGENT runs the call is queued for the user to
   * approve (chat executes directly — the user is present).
   */
  risk?: "safe" | "approval";
  /**
   * Stateful ITERATOR tool: identical args intentionally return a DIFFERENT
   * result each call (a cursor advancing — e.g. projects.focusNext). The
   * loop-guard must NOT memoize these (its "you already called this" echo would
   * freeze the cursor on its first item) and must NOT count them toward the
   * runaway tool-call cap (advancing is progress, not a stuck loop).
   */
  repeatable?: boolean;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  defaultPrompt: string;
  /** Tool names from the global registry this template needs. */
  defaultTools: string[];
  /** Cron pattern, or null for manual-only. */
  defaultSchedule: string | null;
  /**
   * Optional provider/model this template must run on. Life-OS periodic agents
   * pin these to a FREE model (local ollama, or free-tier nvidia cloud) so the
   * heartbeat never bills — see ONE-STOP-PLAN §4. Omit to use agent.default.
   */
  defaultProvider?: "anthropic" | "ollama" | "nvidia" | "mlx";
  defaultModel?: string;
  /**
   * Local Ollama model to retry on if `defaultProvider` is a cloud provider and
   * it fails on connectivity — keeps the heartbeat alive offline / when the
   * cloud is rate-limited. Only meaningful with a cloud `defaultProvider`.
   */
  defaultFallbackModel?: string;
  /**
   * A2 verification: a tool name that must succeed for a run to be "done".
   * The executor fails the run if this tool never returned a non-error result
   * — so a routine can't falsely report success without its effect landing.
   */
  defaultSuccessTool?: string;
  /** Tool-loop budget per run; omit for the provider default (see agents.turnBudget). */
  defaultTurnBudget?: number;
  /** Isolated/focused-domain agent — see agents.isolated. Skips shared-memory
   *  recall-augmentation and memory.update. For single-source read-only agents. */
  defaultIsolated?: boolean;
}

export interface ModuleWidget {
  id: string;
  title: string;
  size: "sm" | "md" | "lg";
  /** May be an async server component — rendered by the dashboard grid. */
  component: ComponentType;
  /**
   * Dashboard value tier, controlling prominence:
   *   1 = "Now" — what needs the user + today's agenda + what to work on next
   *   2 = "In motion" — active work & automation state (default)
   *   3 = "Ambient" — passive counts, rendered as a compact stat in the pulse
   *       strip rather than a full card (requires `stat`).
   */
  priority?: 1 | 2 | 3;
  /** Column span within its tier's grid (tier 1 emphasis). Default 1. */
  span?: number;
  /**
   * Compact single-stat form for the tier-3 pulse strip. When a priority-3
   * widget provides this, the dashboard renders it in the strip instead of
   * the full `component`.
   */
  stat?: ComponentType;
}

export interface ModuleRouteProps {
  /** Path segments after /m/<module-id>/. */
  params: string[];
}

/**
 * Background job handler run by the worker process. The worker LISTENs on
 * `channel`; a NOTIFY with a payload invokes `handle`. Modules use this for
 * async pipelines (e.g. knowledge enrichment) without touching worker code.
 */
export interface ModuleJob {
  channel: string;
  handle(payload: string, ctx: AiToolContext): Promise<void>;
  /** Optional cron pattern — the worker also runs this job on a schedule (payload = ""). */
  schedule?: string;
  /** Run once when the worker boots (in addition to any schedule). For jobs that
   *  keep a persisted cache warm so the first page load isn't cold. */
  runOnBoot?: boolean;
}

export interface ModuleServerManifest {
  id: string;
  /** "" is the module root page; "[id]" matches a single dynamic segment. */
  routes: Record<string, ComponentType<ModuleRouteProps>>;
  widgets: ModuleWidget[];
  schema: Record<string, PgTable>;
  aiTools: AiToolDef[];
  agentTemplates: AgentTemplate[];
  jobs?: ModuleJob[];
}
