import { z } from "zod";
import type { AiToolDef } from "@/core/modules/types.server";
import { serverModules } from "@/modules/registry.server";
import { notify } from "@/core/notify";
import { NOTIFICATION_LEVELS } from "@/core/db/schema/notifications";

/** Core tools available alongside module tools. */
const CORE_TOOLS: AiToolDef[] = [
  {
    name: "search.everything",
    description:
      "Semantic search across ALL the user's data — notes, knowledge base, tasks — by meaning, not just keywords. Use this first when asked about anything the user may have saved.",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(8),
    }),
    async execute(input) {
      const { searchEverything } = await import("@/core/embeddings");
      const hits = await searchEverything(input.query, input.limit);
      return hits.map((h) => ({
        kind: h.kind,
        id: h.id,
        title: h.title,
        snippet: h.snippet,
      }));
    },
  },
  {
    name: "memory.update",
    description:
      "Update a persistent memory block (always-injected context: who_i_am, current_focus, preferences, active_projects, or a new label for a durable topic). Keep blocks concise — they have char budgets; replaced values are archived automatically.",
    input: z.object({
      label: z
        .string()
        .min(1)
        .max(40)
        .describe("Block label, snake_case (existing or new)"),
      value: z.string().min(1),
      mode: z.enum(["replace", "append"]).default("replace"),
      description: z
        .string()
        .optional()
        .describe("What this block holds (only used when creating a new one)"),
    }),
    async execute(input) {
      const { updateMemoryBlock } = await import("@/core/memory");
      const next = await updateMemoryBlock(
        input.label,
        input.value,
        input.mode,
        input.description,
      );
      return { updated: input.label, length: next.length };
    },
  },
  {
    name: "memory.remember",
    description:
      "Store a durable fact, decision, lesson, or event in long-tail memory (searchable later via memory.recall). Use for anything worth not re-learning: 'we decided X because Y', 'approach Z failed due to W'.",
    input: z.object({
      text: z.string().min(1).max(2000),
      kind: z
        .enum(["fact", "decision", "lesson", "event", "policy"])
        .default("fact"),
    }),
    async execute(input, ctx) {
      const { rememberEntry } = await import("@/core/memory");
      const row = await rememberEntry({
        kind: input.kind,
        text: input.text,
        source: ctx.agentRunId ? `agent-run:${ctx.agentRunId}` : "chat",
      });
      return { remembered: row.id };
    },
  },
  {
    name: "memory.recall",
    description:
      "Semantically search long-tail memory (past decisions, lessons, events, superseded context). Check here before redoing work or re-deciding something.",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(6),
    }),
    async execute(input) {
      const { recallEntries } = await import("@/core/memory");
      return await recallEntries(input.query, input.limit);
    },
  },
  {
    name: "memory.review",
    description:
      "Review the NEWEST long-tail memory to consolidate it — optionally filtered by tier (episodic = what happened | semantic = what's true | procedural = how to act). Use to distill recurring episodic events into a durable fact (memory.remember kind 'fact') or an operating rule (kind 'policy').",
    input: z.object({
      tier: z.enum(["episodic", "semantic", "procedural"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async execute(input) {
      const { reviewEntries } = await import("@/core/memory");
      return await reviewEntries(input.tier, input.limit);
    },
  },
  {
    name: "notify.send",
    description:
      "Send the user a notification (bell feed + Slack if configured). Use for reports, reminders, and anything the user should see without opening the app.",
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().optional().describe("Longer text, markdown-ish"),
      level: z.enum(NOTIFICATION_LEVELS).default("info"),
      href: z
        .string()
        .optional()
        .describe("Optional in-app path to link, e.g. /m/tasks"),
    }),
    async execute(input, ctx) {
      const row = await notify({
        ...input,
        source: ctx.agentRunId ? `agent-run:${ctx.agentRunId}` : "chat",
      });
      return { sent: row.id };
    },
  },
  {
    name: "web.search",
    description:
      "Search the live web for CURRENT, authoritative information — standards bodies, official docs, government and reputable primary sources (paywalls and crowd/SEO sites are filtered out). Use for anything the user's own saved data won't have: recent events, external facts, current versions. Returns ranked hits with snippets; call web.read on a hit's url to get its full text. Free (self-hosted SearXNG).",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10).default(6),
    }),
    async execute(input) {
      const { searchWeb } = await import("@/modules/ask/websearch");
      const hits = await searchWeb(input.query, { max: input.limit });
      if (!hits.length)
        return {
          hits: [],
          note: "No results — or web search isn't configured (set the searxng_url setting / SEARXNG_URL env).",
        };
      return { hits };
    },
  },
  {
    name: "web.read",
    description:
      "Fetch a web page and return its clean article text. Reads past most bot-walls/JS via a keyless reader proxy. Use to read or summarize a URL the user pasted, or to get the full text behind a web.search hit.",
    input: z.object({
      url: z.string().url(),
    }),
    async execute(input) {
      const { readArticle } = await import("@/modules/workbench/research");
      const a = await readArticle(input.url);
      if (!a) return { ok: false, error: "Couldn't read that URL (unreachable or empty)." };
      return { title: a.title, url: a.url, text: a.text.slice(0, 12000) };
    },
  },
  {
    name: "agent.subtask",
    description:
      "Investigate ONE focused item in a FRESH, isolated context window and get back only a short summary. Use it to keep YOUR context small when you must cover many items — run one sub-task per project / repo / symbol instead of piling everything into this conversation. The sub-task starts clean and CANNOT see this chat, so put EVERYTHING it needs into `task` (ids, names, what to check). It has read tools and returns just its conclusion (≤ ~4k chars). It cannot spawn further sub-tasks.",
    input: z.object({
      task: z
        .string()
        .min(1)
        .describe(
          "A complete, self-contained instruction. Include all needed context — the sub-task can't see this conversation.",
        ),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Tool names the sub-task may use. Defaults to a read-only subset (search, project/task/notes/knowledge reads, memory recall).",
        ),
    }),
    risk: "safe",
    async execute(input: { task: string; tools?: string[] }, ctx) {
      if ((ctx.subagentDepth ?? 0) >= 1) {
        return { error: "A sub-task cannot spawn further sub-tasks (max depth 1)." };
      }
      const { resolveRoute } = await import("@/core/ai/routing");
      // Falls back to agent.default when no explicit agent.subtask route is set.
      const route = await resolveRoute("agent.subtask");
      const DEFAULT_READ_TOOLS = [
        "search.everything",
        "projects.get",
        "projects.list",
        "tasks.list",
        "notes.search",
        "knowledge.search",
        "memory.recall",
        "market.quote",
      ];
      const wanted = input.tools?.length ? input.tools : DEFAULT_READ_TOOLS;
      // Never hand a sub-task the sub-task tool (recursion) or approval-tier tools.
      const tools = getToolsByNames(wanted).filter(
        (t) => t.name !== "agent.subtask" && t.risk !== "approval",
      );
      let text = "";
      let err: string | null = null;
      try {
        for await (const event of route.provider.run({
          system:
            "You are a focused sub-agent inside apOS. Do exactly the task using your tools, then reply with a concise, factual summary of what you found — no preamble, no restating the task.",
          messages: [{ role: "user", content: input.task }],
          tools,
          toolCtx: {
            db: ctx.db,
            subagentDepth: (ctx.subagentDepth ?? 0) + 1,
            subject: null,
            subjectCursor: null,
          },
          model: route.model,
          maxTurns: 12,
        })) {
          if (event.type === "done") text = event.text;
          if (event.type === "error") err = event.message;
        }
      } catch (e) {
        err = String(e);
      }
      if (err && !text) return { error: err.slice(0, 200) };
      return { summary: (text || "(no result)").slice(0, 4000) };
    },
  },
];

/** All module-declared AI tools, keyed by their dotted name ("tasks.create"). */
export function getToolRegistry(): Map<string, AiToolDef> {
  const map = new Map<string, AiToolDef>();
  for (const t of CORE_TOOLS) map.set(t.name, t);
  for (const mod of serverModules) {
    for (const t of mod.aiTools) {
      if (map.has(t.name)) {
        throw new Error(`Duplicate AI tool name: ${t.name}`);
      }
      map.set(t.name, t);
    }
  }
  return map;
}

export function getAllTools(): AiToolDef[] {
  return [...getToolRegistry().values()];
}

/** Filter an allowlist (agent config) against the registry. */
export function getToolsByNames(names: string[]): AiToolDef[] {
  const reg = getToolRegistry();
  return names.flatMap((n) => {
    const t = reg.get(n);
    return t ? [t] : [];
  });
}
