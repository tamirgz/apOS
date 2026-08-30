import type { ModuleJob } from "@/core/modules/types.server";
import { db } from "@/core/db/client";
import {
  rememberEntry,
  reviewEntries,
  updateMemoryBlock,
} from "@/core/memory";

/**
 * The learning engine: weekly, distills recent EPISODIC events into durable
 * SEMANTIC facts and PROCEDURAL rules (episodic → semantic/procedural), and
 * rebuilds the injected `operating_rules` block from the current top rules.
 *
 * Runs on a FREE LOCAL model — memory work is periodic and must never bill.
 * Conservative + grounded (every item must be supported by real events),
 * bounded (≤3 each), and deduped by rememberEntry, so it can't hallucinate a
 * flood of rules or grow the injected snapshot.
 */
async function llmJson(system: string, user: string): Promise<unknown | null> {
  // Model is the `memory.distill` route — configurable in Settings; a local
  // model by default (memory work never bills).
  const { resolveRoute } = await import("@/core/ai/routing");
  const route = await resolveRoute("memory.distill");
  let text = "";
  try {
    for await (const ev of route.provider.run({
      system,
      messages: [{ role: "user", content: user }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
    })) {
      if (ev.type === "done") text = ev.text;
    }
  } catch {
    return null;
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * Recent agent-run history as episodic material — the richest source of "what
 * happened" (successes, what each agent reported, and failures). Distilling over
 * this is how run experience becomes durable knowledge.
 */
async function recentRunEpisodes(): Promise<string[]> {
  const { agentRuns, agents } = await import("@/core/db/schema/agents");
  const { and, desc, eq, gte } = await import("drizzle-orm");
  const since = new Date(Date.now() - 14 * 86_400_000);
  const rows = await db
    .select({
      name: agents.name,
      status: agentRuns.status,
      transcript: agentRuns.transcript,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(gte(agentRuns.createdAt, since)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(60);
  return rows.map((r) => {
    if (r.status === "failed" || r.status === "timed_out")
      return `${r.name} run ${r.status}${r.error ? `: ${r.error.slice(0, 120)}` : ""}`;
    const done = ((r.transcript as { type?: string; text?: string }[]) ?? [])
      .filter((e) => e?.type === "done")
      .map((e) => e.text ?? "")
      .join(" ")
      .slice(0, 200);
    return `${r.name} ran ${r.status}${done ? `: ${done}` : ""}`;
  });
}

export async function distillMemory(): Promise<{ policies: number; facts: number }> {
  // Genuine memory events only — `superseded` block-dumps (also episodic) are noise.
  const memEvents = (await reviewEntries("episodic", 80))
    .filter((e) => e.kind === "event")
    .map((e) => e.text);
  const runEpisodes = await recentRunEpisodes();
  const episodic = [...memEvents, ...runEpisodes];
  const procedural = await reviewEntries("procedural", 20);
  if (episodic.length < 3) return { policies: 0, facts: 0 }; // nothing to distill yet

  const material = [
    "RECENT ACTIVITY (what happened — agent runs, their reports, and any failures):",
    ...episodic.slice(0, 60).map((t) => `- ${t}`),
    "",
    "EXISTING PROCEDURAL RULES (do NOT duplicate these):",
    ...procedural.map((p) => `- ${p.text}`),
  ].join("\n");
  const system = [
    "You distill a personal operating system's long-tail memory into durable, high-signal knowledge. From the recent EVENTS, extract ONLY genuinely RECURRING patterns or stable truths. Be conservative — most runs yield little or nothing.",
    'Output STRICT JSON and nothing else: {"policies": string[], "facts": string[]}',
    "- policies: at most 3 operating rules like 'When X, do Y', each grounded in the events (e.g. a recurring failure → a rule that avoids it). Never restate an existing rule.",
    "- facts: at most 3 stable truths worth remembering long-term.",
    "Empty arrays if nothing qualifies. Never invent — every item must be supported by the events above.",
  ].join("\n");

  const out = (await llmJson(system, material)) as
    | { policies?: unknown; facts?: unknown }
    | null;
  let policies = 0;
  let facts = 0;
  const pol = Array.isArray(out?.policies) ? out!.policies : [];
  const fac = Array.isArray(out?.facts) ? out!.facts : [];
  const cutoff = Date.now() - 5000; // rows created after this are genuinely new
  const newRules: string[] = [];
  for (const p of pol.slice(0, 3)) {
    if (typeof p === "string" && p.trim().length > 10) {
      const row = await rememberEntry({ kind: "policy", source: "distill", text: p.trim() }).catch(() => null);
      if (row) {
        policies++;
        if (+new Date(row.createdAt) >= cutoff) newRules.push(row.text); // not a dedup
      }
    }
  }
  for (const f of fac.slice(0, 3)) {
    if (typeof f === "string" && f.trim().length > 10) {
      await rememberEntry({ kind: "fact", source: "distill", text: f.trim() }).catch(() => {});
      facts++;
    }
  }
  // Rebuild the injected procedural block from the current top POLICIES only
  // (crisp operating rules — not the longer free-form lessons), bounded.
  if (policies) {
    const rules = (await reviewEntries("procedural", 20))
      .filter((r) => r.kind === "policy")
      .slice(0, 8);
    const body = rules.map((r) => `- ${r.text}`).join("\n").slice(0, 1000);
    if (body) {
      await updateMemoryBlock(
        "operating_rules",
        body,
        "replace",
        "Learned operating rules distilled from experience.",
      ).catch(() => {});
    }
  }
  // Surface each genuinely-new rule so a learned policy is never injected into
  // every agent silently — you see what the system decided to believe. This is
  // a system-wide FYI (nothing to do or approve), so it belongs in the bell
  // feed, NOT "Needs You" — that queue is for what actually needs the user, and
  // an attention card would also get mis-grounded to a random project by title.
  if (newRules.length) {
    try {
      const { notify } = await import("@/core/notify");
      await notify({
        title: `Memory learned ${newRules.length} new operating rule${newRules.length > 1 ? "s" : ""}`,
        body:
          newRules.map((r) => `• ${r}`).join("\n") +
          "\n\nThese now guide every agent run. Review or edit them in Settings → Memory.",
        level: "info",
        source: "memory",
        href: "/m/settings/memory",
      });
    } catch {
      // surfacing is best-effort
    }
  }
  return { policies, facts };
}

export const memoryDistillJobs: ModuleJob[] = [
  {
    channel: "memory_distill",
    schedule: "0 4 * * 0", // Sunday 04:00, after the daily maintenance sweep
    handle: async () => {
      await distillMemory();
    },
  },
];
