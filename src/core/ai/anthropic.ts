import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { ZodObject, ZodRawShape } from "zod";
import type {
  AIEvent,
  AIProvider,
  AIRunOptions,
} from "./provider";
import { fromWireName, toWireName } from "./provider";
import { enforceSubscriptionAuth } from "./auth";
import { invokeTool } from "./invoke-tool";

// Runs once, before the SDK can spawn its runtime: a metered key present in
// the environment would take precedence over the Max subscription.
enforceSubscriptionAuth();

const MCP_SERVER = "aios";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/**
 * Runs on the user's Claude Max subscription via CLAUDE_CODE_OAUTH_TOKEN
 * (`claude setup-token`) — no API key. The SDK spawns the bundled Claude Code
 * runtime, which inherits our env. Module tools are exposed through an
 * in-process MCP server; allowedTools restricts the model to exactly those
 * (no file/bash access).
 */
export const anthropicProvider: AIProvider = {
  id: "anthropic",

  async listModels() {
    // No model-listing endpoint with subscription auth — curated list.
    return ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"];
  },

  async *run(opts: AIRunOptions): AsyncIterable<AIEvent> {
    const mcpTools = opts.tools.map((t) =>
      tool(
        toWireName(t.name),
        t.description,
        (t.input as ZodObject<ZodRawShape>).shape,
        async (input) => {
          const result = await invokeTool(t, input, opts.toolCtx);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result ?? null) },
            ],
          };
        },
      ),
    );

    const server = createSdkMcpServer({
      name: MCP_SERVER,
      version: "1.0.0",
      tools: mcpTools,
    });

    // Flatten chat history into one prompt (short histories; sessions later).
    const promptText = opts.messages
      .map((m) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`))
      .join("\n\n");

    let finalText = "";

    try {
      const q = query({
        prompt: promptText,
        options: {
          model: opts.model,
          systemPrompt:
            opts.system ??
            "You are the AI core of apOS, the user's Agentic Personalized Operating System.",
          mcpServers: { [MCP_SERVER]: server },
          allowedTools: opts.tools.map((t) => MCP_PREFIX + toWireName(t.name)),
          // Block the SDK's built-in tools: no filesystem/web, and crucially no
          // Task/Agent SPAWNER — a background agent must do the work itself with
          // its module tools, not delegate to a sub-agent that runs in a
          // detached context (which can't see the run's bound subject, so it
          // reported "no active projects" and wrote nothing).
          disallowedTools: [
            "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
            "Task", "Agent", "TodoWrite", "NotebookEdit",
          ],
          permissionMode: "bypassPermissions",
          maxTurns: opts.maxTurns ?? 12,
          abortController: opts.signal
            ? abortControllerFrom(opts.signal)
            : undefined,
        },
      });

      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim()) {
              finalText = block.text;
              yield { type: "text", text: block.text };
            } else if (
              block.type === "tool_use" &&
              block.name.startsWith(MCP_PREFIX)
            ) {
              // Internal harness tools (ToolSearch etc.) are not surfaced.
              yield {
                type: "tool_call",
                name: deNamespace(block.name),
                input: block.input,
              };
            }
          }
        } else if (msg.type === "user") {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "tool_result"
              ) {
                yield {
                  type: "tool_result",
                  name: "tool",
                  result: summarizeToolResult(block.content),
                };
              }
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success" && msg.result) finalText = msg.result;
          yield {
            type: "usage",
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          };
        }
      }

      yield { type: "done", text: finalText };
    } catch (e) {
      yield { type: "error", message: String(e) };
    }
  },
};

function deNamespace(name: string): string {
  return name.startsWith(MCP_PREFIX)
    ? fromWireName(name.slice(MCP_PREFIX.length))
    : name;
}

function summarizeToolResult(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? (b as { text: string }).text
          : "",
      )
      .join("");
  }
  return content;
}

function abortControllerFrom(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
