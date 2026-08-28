import { and, eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, sql } from "@/core/db/client";
import {
  agentLedger,
  agentRuns,
  agents,
  type Agent,
} from "@/core/db/schema/agents";
import type { AIEvent, AIProvider } from "@/core/ai/provider";
import { providers, resolveRoute } from "@/core/ai/routing";
import { getToolsByNames } from "@/core/ai/tool-registry";
import { reportAgentRunOutcome } from "@/core/alerts";
import type { AiToolDef } from "@/core/modules/types.server";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;

function ledgerFor(agentId: string, runId: string) {
  return {
    async has(itemKey: string) {
      const rows = await db
        .select({ id: agentLedger.id })
        .from(agentLedger)
        .where(
          and(
            eq(agentLedger.agentId, agentId),
            eq(agentLedger.itemKey, itemKey),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async mark(itemKey: string, result?: unknown) {
      await db
        .insert(agentLedger)
        .values({ agentId, itemKey, runId, result: result ?? null })
        .onConflictDoNothing();
    },
  };
}

/** Built-in idempotency tools injected into every agent run. */
function ledgerTools(ledger: ReturnType<typeof ledgerFor>): AiToolDef[] {
  return [
    {
      name: "ledger.has",
      description:
        "Check whether an item key was already processed in a previous run. Always check before acting on an item.",
      input: z.object({ itemKey: z.string().min(1) }),
      execute: async (i: { itemKey: string }) => ({
        processed: await ledger.has(i.itemKey),
      }),
    },
    {
      name: "ledger.mark",
      description:
        "Mark an item key as processed so future runs skip it. Include a short result summary.",
      input: z.object({
        itemKey: z.string().min(1),
        result: z.string().optional(),
      }),
      execute: async (i: { itemKey: string; result?: string }) => {
        await ledger.mark(i.itemKey, i.result);
        return { marked: i.itemKey };
      },
    },
  ];
}

async function patchRun(runId: string, patch: Record<string, unknown>) {
  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId));
  await sql.notify("agent_runs", runId);
}

async function appendEvent(runId: string, event: AIEvent) {
  await db
    .update(agentRuns)
    .set({
      transcript: dsql`${agentRuns.transcript} || ${JSON.stringify([event])}::jsonb`,
      heartbeatAt: new Date(),
    })
    .where(eq(agentRuns.id, runId));
  await sql.notify("agent_runs", runId);
}

/** Insert a queued run; returns null if one is already live (unique index). */
export async function enqueueRun(
  agentId: string,
  trigger: "cron" | "manual",
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(agentRuns)
      .values({ agentId, trigger, status: "queued" })
      .returning({ id: agentRuns.id });
    await sql.notify("agent_runs", row.id);
    return row.id;
  } catch {
    return null; // live run exists — skip (croner overrun / double click)
  }
}

export async function executeRun(runId: string): Promise<void> {
  // Atomic claim: only one caller wins the queued→running transition, so the
  // NOTIFY path and the periodic pick-up sweep can never double-execute.
  const [claimed] = await db
    .update(agentRuns)
    .set({
      status: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")))
    .returning();
  if (!claimed) return;
  await sql.notify("agent_runs", runId);
  const run = claimed;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, run.agentId));
  if (!agent) {
    await patchRun(runId, {
      status: "failed",
      error: "agent not found",
      finishedAt: new Date(),
    });
    return;
  }

  try {
    const { provider, model } = await routeFor(agent);
    const ledger = ledgerFor(agent.id, runId);
    // ledger.* and the memory suite are always available, like in chat.
    // Approval-tier tools are wrapped: unattended runs queue the call for the
    // user instead of executing it.
    // Isolated agents get ONLY memory.remember (to save their own findings) — no
    // memory.update/recall, so a focused read-only agent can neither read nor
    // overwrite the shared working memory. Normal agents get the full suite.
    const memoryToolNames = agent.isolated
      ? ["memory.remember"]
      : ["memory.update", "memory.remember", "memory.recall"];
    const tools = [
      ...getToolsByNames([...new Set([...agent.tools, ...memoryToolNames])]).map(
        (t) => (t.risk === "approval" ? wrapWithApproval(t, agent, runId) : t),
      ),
      ...ledgerTools(ledger),
    ];

    const { renderMemoryContext, recallSemantic, recallAgentLessons } =
      await import("@/core/memory");
    // Retrieval-augment the run across the WHOLE ecosystem — the agent's own
    // memory (lessons/decisions/facts) PLUS the user's knowledge base and notes,
    // ranked by relevance to this agent's task. So accumulated wisdom and saved
    // knowledge actually shape the work instead of sitting unused. Bounded
    // (top 5 snippets) and best-effort — never blocks or bloats the run.
    // Isolated agents skip recall-augmentation entirely — injecting unrelated
    // memory/knowledge is exactly what misleads a focused single-source agent.
    let recalled = "";
    try {
      if (agent.isolated) throw new Error("isolated: skip recall");
      const hits = await recallSemantic(`${agent.name}. ${agent.prompt}`.slice(0, 800), {
        // memory + the user's whole durable knowledge: knowledge base, notes,
        // and their Obsidian vault (second brain).
        kinds: ["memory", "knowledge", "note", "vault"],
        limit: 5,
      });
      if (hits.length) {
        recalled = [
          "",
          "RELEVANT CONTEXT (from your memory + the user's knowledge base/notes — apply lessons, reuse what's already known, don't repeat a past mistake or re-decide a settled question):",
          ...hits.map((h) => `• [${h.kind}] ${h.text}`),
        ].join("\n");
      }
    } catch {
      // recall is best-effort — a memory hiccup must not affect the run
    }
    // Self-learning: this agent's OWN lessons from past runs (it wrote them when
    // it reflected on earlier runs), recalled explicitly so they always surface —
    // not left to semantic ranking. Isolated agents keep their single-source mind.
    let ownLessons = "";
    try {
      if (!agent.isolated) {
        const lessons = await recallAgentLessons(agent.name, 5);
        if (lessons.length) {
          ownLessons = [
            "",
            "YOUR OWN LESSONS FROM PAST RUNS (you wrote these — apply them; don't repeat a mistake you already learned from):",
            ...lessons.map((l) => `• ${l}`),
          ].join("\n");
        }
      }
    } catch {
      // best-effort
    }
    const system = [
      `You are "${agent.name}", an autonomous background agent inside apOS, the user's Agentic Personalized Operating System.`,
      "You run unattended — do the work with your tools, then produce a concise final report of what you did and found.",
      "Idempotency: use ledger.has to check items before acting and ledger.mark after processing. Never redo work a previous run already did.",
      "Write discipline: only call a mutating tool (create, update, delete, send, notify) when your task explicitly calls for that change. When reading or gathering context, use read-only tools — never create, modify, or send anything as an incidental side effect.",
      `Current date-time: ${new Date().toISOString()}`,
      "",
      await renderMemoryContext(),
      recalled,
      ownLessons,
    ].join("\n");

    // One provider attempt, with its own timeout + heartbeat so a fallback
    // attempt gets a fresh clock (the primary's abort signal is already spent).
    const attempt = async (prov: AIProvider, mdl: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
      const heartbeat = setInterval(() => {
        db.update(agentRuns)
          .set({ heartbeatAt: new Date() })
          .where(eq(agentRuns.id, runId))
          .catch(() => {});
      }, HEARTBEAT_MS);
      let finalText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let errored: string | null = null;
      const okTools = new Set<string>(); // tools that returned a non-error result
      try {
        for await (const event of prov.run({
          system,
          messages: [{ role: "user", content: agent.prompt }],
          tools,
          // subject/subjectCursor start empty; a cursor tool (projects.focusNext)
          // binds the subject so per-subject writes never carry a model id.
          toolCtx: { db, agentRunId: runId, ledger, subject: null, subjectCursor: null },
          model: mdl,
          // Per-agent tool-loop budget; undefined falls back to the provider
          // default. Lets a many-item agent finish the list instead of
          // truncating at the default cap.
          maxTurns: agent.turnBudget ?? undefined,
          signal: controller.signal,
        })) {
          await appendEvent(runId, event);
          if (event.type === "done") finalText = event.text;
          if (event.type === "error") errored = event.message;
          if (
            event.type === "tool_result" &&
            !(event.result as { error?: unknown } | null)?.error
          ) {
            okTools.add(event.name);
          }
          if (event.type === "usage") {
            tokensIn += event.inputTokens;
            tokensOut += event.outputTokens;
          }
        }
      } catch (e) {
        errored = String(e);
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
      }
      return { finalText, tokensIn, tokensOut, errored, okTools, aborted: controller.signal.aborted };
    };

    let res = await attempt(provider, model);

    // Fallback → Ollama: if the primary fails (connectivity, timeout, rate-limit,
    // LM Studio down, any error) and the agent has a local fallback, retry once
    // on Ollama — so a periodic heartbeat survives a flaky cloud OR a stopped
    // LM Studio (the MLX host). Ollama is the always-on local baseline.
    if (
      res.errored &&
      (provider.id === "nvidia" || provider.id === "mlx") &&
      agent.fallbackModel
    ) {
      await appendEvent(runId, {
        type: "text",
        text: `⚠︎ Cloud model "${model}" failed (${res.errored.slice(0, 120)}). Falling back to local ollama/${agent.fallbackModel}.`,
      });
      const fb = await attempt(providers.ollama, agent.fallbackModel);
      res = {
        finalText: fb.finalText,
        tokensIn: res.tokensIn + fb.tokensIn,
        tokensOut: res.tokensOut + fb.tokensOut,
        errored: fb.errored,
        okTools: fb.okTools,
        aborted: fb.aborted,
      };
    }

    // A2 verification gate: a run with a declared successTool is only "done" if
    // that tool actually succeeded — otherwise it's a failure, not a false done.
    const verifyFailed =
      !res.errored &&
      !!agent.successTool &&
      !res.okTools.has(agent.successTool);

    const terminal =
      res.errored || verifyFailed
        ? {
            status: res.aborted ? "timed_out" : "failed",
            error:
              res.errored ??
              `verification failed: the run never completed a successful "${agent.successTool}" call`,
            finishedAt: new Date(),
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
          }
        : {
            status: "succeeded",
            result: res.finalText,
            finishedAt: new Date(),
            tokensIn: res.tokensIn,
            tokensOut: res.tokensOut,
          };
    await patchRun(runId, terminal);
    // Make failures noisy (transition-based bell + Slack + self-closing card);
    // best-effort, never affects the run's own outcome.
    await reportAgentRunOutcome({
      agent: { id: agent.id, name: agent.name },
      runId,
      trigger: run.trigger,
      status: terminal.status,
      error: "error" in terminal ? terminal.error : null,
    });
    // Self-feedback: reflect on this run and store a scoped lesson for next time
    // (free local model, fire-and-forget — never delays or affects the run).
    if (!agent.isolated) {
      void (async () => {
        try {
          const { reflectOnRun } = await import("@/core/memory");
          await reflectOnRun({
            agentName: agent.name,
            prompt: agent.prompt,
            status: terminal.status,
            error: "error" in terminal ? terminal.error : null,
            report: terminal.status === "succeeded" ? res.finalText : null,
          });
        } catch {
          /* best-effort */
        }
      })();
    }

    // Learning loop — bank a genuine failure (not a transient timeout) as an
    // EPISODIC event, so the weekly distillation can abstract a recurring
    // failure into a procedural rule. Deduped + best-effort; never affects the
    // run's own outcome.
    if ((res.errored && !res.aborted) || verifyFailed) {
      try {
        const { rememberEntry } = await import("@/core/memory");
        const why = verifyFailed
          ? `did not complete its required "${agent.successTool}" step`
          : (res.errored ?? "").slice(0, 200);
        await rememberEntry({
          kind: "event",
          source: `agent-run:${agent.name}`,
          text: `Agent "${agent.name}" failed — ${why}.`,
        });
      } catch {
        // capture is best-effort
      }
    }
  } catch (e) {
    await patchRun(runId, {
      status: "failed",
      error: String(e),
      finishedAt: new Date(),
    });
    await reportAgentRunOutcome({
      agent: { id: agent.id, name: agent.name },
      runId,
      trigger: run.trigger,
      status: "failed",
      error: String(e),
    });
  }
}

function wrapWithApproval(
  tool: AiToolDef,
  agent: Agent,
  runId: string,
): AiToolDef {
  return {
    ...tool,
    description: `${tool.description} NOTE: this action requires the user's approval — calling it queues the request; it executes only after the user approves.`,
    async execute(input) {
      const { approvals } = await import("@/core/db/schema/approvals");
      const { notify } = await import("@/core/notify");
      const [row] = await db
        .insert(approvals)
        .values({
          agentId: agent.id,
          runId,
          agentName: agent.name,
          toolName: tool.name,
          input,
        })
        .returning();
      await sql.notify("approvals_changed", row.id);
      await notify({
        title: `Approval needed: ${tool.name}`,
        body: `Agent "${agent.name}" wants to run ${tool.name} with:\n${JSON.stringify(input, null, 2).slice(0, 400)}`,
        level: "warn",
        source: `agent:${agent.name}`,
        href: "/m/agents",
      });
      return {
        pending_approval: row.id,
        note: "Queued for the user's approval; it will execute once approved. Mention this in your report.",
      };
    },
  };
}

/** Called by the worker when the user approves — executes the parked call. */
export async function executeApproval(approvalId: string): Promise<void> {
  const { approvals } = await import("@/core/db/schema/approvals");
  const { notify } = await import("@/core/notify");
  const [row] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!row || row.status !== "approved") return;

  const tool = getToolsByNames([row.toolName])[0];
  const patch = async (p: Record<string, unknown>) => {
    await db.update(approvals).set(p).where(eq(approvals.id, approvalId));
    await sql.notify("approvals_changed", approvalId);
  };

  try {
    if (!tool) throw new Error(`tool ${row.toolName} no longer exists`);
    const input = tool.input.parse(row.input);
    const result = await tool.execute(input, { db });
    await patch({ status: "executed", result: result ?? null });
    await notify({
      title: `Approved & done: ${row.toolName}`,
      body: JSON.stringify(result ?? {}).slice(0, 300),
      level: "success",
      source: `agent:${row.agentName}`,
    });
  } catch (e) {
    await patch({ status: "failed", result: { error: String(e) } });
    await notify({
      title: `Approved action failed: ${row.toolName}`,
      body: String(e).slice(0, 300),
      level: "warn",
      source: `agent:${row.agentName}`,
    });
  }
}

async function routeFor(agent: Agent) {
  if (agent.provider && agent.model) {
    return { provider: providers[agent.provider], model: agent.model };
  }
  const route = await resolveRoute(`agent:${agent.id}`);
  return { provider: route.provider, model: route.model };
}
