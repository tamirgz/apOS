import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import type { AIProviderId } from "@/core/db/schema/ai-routes";

export type AIEvent =
  | { type: "text"; text: string }
  // Chain-of-thought from a reasoning model (LM Studio/MLX emit it on a separate
  // `reasoning_content` channel). Surfaced so the UI can show a "thinking…"
  // state instead of dead air; it is NOT part of the final answer.
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIRunOptions {
  system?: string;
  messages: ChatMessage[];
  tools: AiToolDef[];
  toolCtx: AiToolContext;
  model: string;
  maxTurns?: number;
  signal?: AbortSignal;
  // Reasoning hint for local reasoning-capable models (MLX/LM Studio). Omitted →
  // the provider decides (MLX: light reasoning for agentic/tool runs so the model
  // can plan its writes, none for pure chat). An INTERACTIVE caller that wants to
  // stay snappy can force "none" — measured: on the coder-instruct chat model,
  // reasoning yields no thinking tokens but adds latency (up to 6.7×) and can
  // trigger spurious tool calls. Providers without a reasoning channel ignore it.
  reasoning?: "none" | "low";
  /**
   * Optional queue-visibility descriptor. The provider wrapper (core/ai/routing
   * → model-track) registers a live model-call row for this run; `track` labels
   * it and, when `parentKind` names a queue-backed run (agent/chat/workbench),
   * lets the queue fold this call into the rich parent row instead of showing a
   * bare generation row. Omitted → the call is still tracked, as "unknown".
   */
  track?: ModelTrack;
}

/** How a model call presents in the run queue (see core/ai/model-track). */
export interface ModelTrack {
  /** Origin class: agent | chat | workbench | job | gate | ask | flow | subtask | test | … */
  source: string;
  label?: string;
  parentKind?: string | null;
  parentId?: string | null;
}

export interface AIProvider {
  id: AIProviderId;
  listModels(): Promise<string[]>;
  run(opts: AIRunOptions): AsyncIterable<AIEvent>;
}

/**
 * Tool names are dotted internally ("tasks.create") but both the OpenAI
 * function-calling API and MCP restrict names to [a-zA-Z0-9_-], so dots are
 * replaced on the wire and mapped back on the way in.
 */
export const toWireName = (name: string) => name.replaceAll(".", "__");
export const fromWireName = (name: string) => name.replaceAll("__", ".");
