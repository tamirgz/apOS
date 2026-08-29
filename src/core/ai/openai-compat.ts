/**
 * Shared streaming + tool-loop runner for any OpenAI-compatible local endpoint
 * — Ollama (`/v1`) and `mlx_lm.server` both speak this. Factored out so a new
 * local runtime is a ~10-line provider (base URL + listModels) instead of a
 * copy of the whole agentic loop.
 */
import OpenAI from "openai";
import { z } from "zod";
import type { AIEvent, AIRunOptions } from "./provider";
import { fromWireName, toWireName } from "./provider";
import { acquireLocalSlot } from "./local-queue";

export async function* runOpenAICompatible(
  baseURL: string,
  apiKey: string,
  opts: AIRunOptions,
  // Extra fields merged into each chat-completions request — e.g. LM Studio's
  // `reasoning_effort: "none"` to keep a Qwen3 reasoning model snappy. Ollama
  // ignores unknown fields, so this stays empty for it.
  extraBody: Record<string, unknown> = {},
  // Serialize the model-generation call through the local-inference queue (only
  // for on-machine runtimes — Ollama/LM Studio — so concurrent runs don't thrash
  // the GPU). The slot is held ONLY around generation and freed during tool
  // execution, so a tool's own local call (embedText) can't deadlock the run.
  // Cloud callers (OpenRouter) leave this false.
  serializeLocal = false,
): AsyncIterable<AIEvent> {
  const openai = new OpenAI({ baseURL, apiKey });
  const maxTurns = opts.maxTurns ?? 8;

  const tools = opts.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: toWireName(t.name),
      description: t.description,
      parameters: z.toJSONSchema(t.input) as Record<string, unknown>,
    },
  }));

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  // Runaway-loop guard. Some local models (notably qwen coder variants) re-call
  // the same read tools over and over instead of answering, which wastes time
  // and — once the piled-up tool messages hit an MLX/LM Studio limit — throws
  // "Operation not supported". So: memoize identical calls (return the earlier
  // result instead of re-executing, with a nudge to stop), and once a call cap
  // is hit, force a final tool-free turn so the model MUST produce its answer.
  const toolMemo = new Map<string, unknown>();
  let totalToolCalls = 0;
  let nudged = false;
  const TOOL_CALL_CAP = 10;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const forceAnswer = totalToolCalls >= TOOL_CALL_CAP;
      if (forceAnswer && !nudged) {
        messages.push({
          role: "system",
          content:
            "You have gathered enough information. Do NOT call any more tools — write your final answer now using the results already returned.",
        });
        nudged = true;
      }
      // Streaming: yield text as it generates — a big local model can take
      // many seconds per turn, and a silent wait reads as a hang in the UI.
      let turnText = "";
      let turnReasoning = "";
      const toolCallAcc = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      // Hold a local-inference slot around JUST this generation call — released
      // in the finally before tool execution, so a tool's own local call
      // (attention.raise → embedText) can acquire the slot instead of
      // deadlocking against a run that held it for its whole lifetime.
      const releaseSlot = serializeLocal ? await acquireLocalSlot() : null;
      try {
      const stream = await openai.chat.completions.create(
        {
          model: opts.model,
          messages,
          tools: !forceAnswer && tools.length ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
          ...extraBody,
        },
        { signal: opts.signal },
      );

      for await (const chunk of stream) {
        const usage = chunk.usage;
        if (usage) {
          inputTokens += usage.prompt_tokens ?? 0;
          outputTokens += usage.completion_tokens ?? 0;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        // Reasoning models (e.g. Qwen3 MoE via LM Studio/MLX) stream their
        // chain-of-thought on a separate `reasoning_content` field before any
        // answer content. Surface it as a distinct event so the UI shows a
        // "thinking…" state — this phase can run many seconds — but keep it out
        // of the answer text and out of finalText.
        const reasoningDelta = (delta as { reasoning_content?: string })
          .reasoning_content;
        if (reasoningDelta) {
          turnReasoning += reasoningDelta;
          yield { type: "reasoning", text: turnReasoning };
        }
        if (delta.content) {
          turnText += delta.content;
          yield { type: "text", text: turnText };
        }
        for (const tc of delta.tool_calls ?? []) {
          const acc = toolCallAcc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCallAcc.set(tc.index, acc);
        }
      }
      } finally {
        releaseSlot?.();
      }

      if (turnText) finalText = turnText;

      const calls = [...toolCallAcc.values()].filter((c) => c.name);
      if (calls.length === 0) break;

      messages.push({
        role: "assistant",
        content: turnText || null,
        tool_calls: calls.map((c) => ({
          id: c.id || `call_${c.name}`,
          type: "function" as const,
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });
      for (const call of calls) {
        const name = fromWireName(call.name);
        const def = opts.tools.find((t) => t.name === name);
        const sig = `${name}(${call.args || "{}"})`;
        // Iterator tools (projects.focusNext) return a DIFFERENT result on each
        // identical call — memoizing them freezes their cursor and capping them
        // truncates a legitimate multi-item sweep. Exempt from both guards, and
        // treat an advance as PROGRESS: reset the runaway budget so each item
        // gets a fresh cap. A model that loops WITHOUT advancing still trips it.
        const repeatable = def?.repeatable === true;
        if (repeatable) {
          totalToolCalls = 0;
          nudged = false;
        } else {
          totalToolCalls++;
        }
        let result: unknown;
        if (!def) {
          result = { error: `unknown tool ${name}` };
          yield { type: "tool_call", name, input: {} };
        } else if (!repeatable && toolMemo.has(sig)) {
          // Identical call already made this run — return the earlier result
          // (no re-execution) and tell the model to stop and answer.
          const prior = toolMemo.get(sig);
          result = {
            ...(prior && typeof prior === "object" ? prior : { value: prior }),
            _note:
              "You already called this tool with these arguments — use this result and do NOT call it again. Write your answer now.",
          };
          // no tool_call event: avoid spamming the UI with repeat chips
        } else {
          try {
            const input = def.input.parse(JSON.parse(call.args || "{}"));
            yield { type: "tool_call", name, input };
            result = await def.execute(input, opts.toolCtx);
            if (!repeatable) toolMemo.set(sig, result);
          } catch (e) {
            result = { error: String(e) };
          }
        }
        yield { type: "tool_result", name, result };
        messages.push({
          role: "tool",
          tool_call_id: call.id || `call_${call.name}`,
          content: JSON.stringify(result ?? null),
        });
      }
    }

    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done", text: finalText };
  } catch (e) {
    yield { type: "error", message: String(e) };
  }
}
