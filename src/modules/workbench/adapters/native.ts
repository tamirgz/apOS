/**
 * The native executor: apOS's own provider layer plus the module tool
 * registry. No subprocess, no repo — this is the executor for work whose
 * subject *is* apOS's data ("summarize my open ideas into a note"), and it
 * runs on whatever provider the route says, so it can be entirely local.
 */
import { db } from "@/core/db/client";
import { providers, resolveRoute } from "@/core/ai/routing";
import type { Adapter, AdapterContext, AdapterResult } from "./types";

/**
 * Guarantee every chart the prompt declared is present in the output. The prompt
 * may carry a "CHART EMBEDS" block of lines like
 *   `- LABEL (Section name): ![title](/api/charts/<id>)`
 * Local models often drop these. For each declared embed missing from the
 * report, insert it right after that section's `##` heading (or append it).
 */
function ensureChartsPresent(prompt: string, report: string): string {
  const directive =
    /^\s*[-*]\s*.+?\(([^)]+)\):\s*(!\[[^\]]*\]\(\/api\/charts\/[0-9a-f-]+\))/gim;
  const charts: { section: string; embed: string; url: string }[] = [];
  for (const m of prompt.matchAll(directive)) {
    const url = m[2].match(/\/api\/charts\/[0-9a-f-]+/)?.[0] ?? "";
    charts.push({ section: m[1].trim(), embed: m[2], url });
  }
  if (!charts.length) return report;

  let out = report;
  for (const c of charts) {
    if (!c.url || out.includes(c.url)) continue; // already placed
    // Find the section heading containing (most of) the section name.
    const words = c.section.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const lines = out.split("\n");
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^#{1,6}\s/.test(l)) {
        const low = l.toLowerCase();
        if (words.some((w) => low.includes(w))) {
          at = i;
          break;
        }
      }
    }
    if (at >= 0) {
      lines.splice(at + 1, 0, "", c.embed);
      out = lines.join("\n");
    } else {
      out += `\n\n${c.embed}`;
    }
  }
  return out;
}

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
        // A "docs" write (e.g. the Investments deep report) is prose from
        // provided data — NOT an agentic loop. Force reasoning OFF so a local
        // MLX model doesn't spend minutes on chain-of-thought (which, on the
        // 30B/35B, stretched the stream until LM Studio dropped it: "terminated").
        reasoning: ctx.taskType === "docs" ? "none" : undefined,
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
            // Local models often DROP the chart-embed lines they were asked to
            // copy. If the prompt declared charts (a "CHART EMBEDS" block), make
            // sure every one lands in the output — inserting any the model
            // dropped into its named section — so the report always has its
            // graphs regardless of how faithfully the model copied.
            finalText = ensureChartsPresent(ctx.prompt, event.text);
            await emit({ type: "result", payload: { text: finalText } });
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
