/**
 * The native executor: apOS's own provider layer plus the module tool
 * registry. No subprocess, no repo — this is the executor for work whose
 * subject *is* apOS's data ("summarize my open ideas into a note"), and it
 * runs on whatever provider the route says, so it can be entirely local.
 */
import { db } from "@/core/db/client";
import { providers, resolveRoute } from "@/core/ai/routing";
import type { Adapter, AdapterContext, AdapterResult } from "./types";

export const nativeAdapter: Adapter = {
  id: "native",

  async run(ctx: AdapterContext, emit): Promise<AdapterResult> {
    const route = await resolveRoute("workbench.native");
    // The engine may hand us a NAMESPACED model id (workbench convention:
    // "ollama/…", "mlx/…", "nvidia/…"). Strip the namespace and use it to pick
    // the apOS provider; a bare name is Ollama unless it's a known MLX model.
    const resolve = async (raw: string) => {
      const slash = raw.indexOf("/");
      const ns = slash > 0 ? raw.slice(0, slash) : "";
      const bare = slash > 0 ? raw.slice(slash + 1) : raw;
      if (ns === "ollama") return { provider: providers.ollama, model: bare };
      if (ns === "mlx") return { provider: providers.mlx, model: bare };
      if (ns === "nvidia") return { provider: providers.nvidia, model: bare };
      if (ns === "anthropic" || raw.startsWith("claude"))
        return { provider: providers.anthropic, model: bare };
      const { getSetting } = await import("@/core/app-settings");
      const mlx = ((await getSetting("mlx_models").catch(() => null))?.trim() ?? "")
        .split(/[\n,]+/)
        .map((s) => s.trim());
      if (mlx.includes(raw) || /abliterated|-mlx\b/i.test(raw))
        return { provider: providers.mlx, model: raw };
      return { provider: providers.ollama, model: raw };
    };
    const resolved = ctx.model
      ? await resolve(ctx.model)
      : { provider: route.provider, model: route.model };
    const provider = resolved.provider;
    const model = resolved.model;

    await emit({
      type: "status",
      payload: { phase: "started", model, provider: provider.id },
    });

    const { renderMemoryContext } = await import("@/core/memory");
    // Imported here, not at module scope: the tool registry pulls in every
    // module's server manifest — including this module's — so a static import
    // closes a cycle back to the engine. Lazily it resolves at call time,
    // when every manifest is already initialized.
    const { getAllTools } = await import("@/core/ai/tool-registry");
    const tools = getAllTools();

    let finalText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let error: string | null = null;

    try {
      for await (const event of provider.run({
        system: [
          "You are the apOS Workbench executor running a one-off task the user delegated.",
          "You run unattended: do the work with your tools, then finish with a concise report of what you did and what you found.",
          "Prefer acting (creating the note, updating the item) over describing what could be done.",
          `Current date-time: ${new Date().toISOString()}`,
          "",
          await renderMemoryContext(),
        ].join("\n"),
        messages: [{ role: "user", content: ctx.prompt }],
        tools,
        toolCtx: { db },
        model,
        signal: ctx.signal,
        track: {
          source: "workbench",
          label: "workbench task",
          parentKind: "workbench",
          parentId: ctx.attemptId,
        },
      })) {
        switch (event.type) {
          case "text":
            await emit({ type: "text", payload: { text: event.text } });
            break;
          case "tool_call":
            await emit({
              type: "tool_call",
              payload: { name: event.name, input: event.input },
            });
            break;
          case "tool_result":
            await emit({
              type: "tool_result",
              payload: { name: event.name, result: event.result },
            });
            break;
          case "usage":
            inputTokens += event.inputTokens;
            outputTokens += event.outputTokens;
            break;
          case "done":
            finalText = event.text;
            await emit({ type: "result", payload: { text: event.text } });
            break;
          case "error":
            error = event.message;
            await emit({ type: "error", payload: { message: event.message } });
            break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await emit({ type: "error", payload: { message: error } });
    }

    if (error) return { ok: false, error, inputTokens, outputTokens };
    return { ok: true, result: finalText, inputTokens, outputTokens };
  },
};
