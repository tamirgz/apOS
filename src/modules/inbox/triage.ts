import { eq } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { resolveRoute } from "@/core/ai/routing";
import { inboxItems } from "./schema";

const TRIAGE_TOOLS = [
  "tasks.create",
  "tasks.list",
  "tasks.setStatus",
  "notes.create",
  "knowledge.capture",
  "ideas.capture",
];

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Map the tool the triage used → a destination label + link to the new item. */
function routeFor(
  tool: string,
  result: unknown,
): { kind: string; label: string; href: string } | null {
  const r = (result ?? {}) as {
    created?: { id?: string };
    captured?: { id?: string };
    updated?: { id?: string };
    id?: string;
  };
  const id = r.created?.id ?? r.captured?.id ?? r.updated?.id ?? r.id;
  switch (tool) {
    case "tasks.create":
      return { kind: "task", label: "Task", href: id ? `/m/tasks/${id}` : "/m/tasks" };
    case "tasks.setStatus":
      return { kind: "task", label: "Task updated", href: id ? `/m/tasks/${id}` : "/m/tasks" };
    case "notes.create":
      return { kind: "note", label: "Note", href: id ? `/m/notes/${id}` : "/m/notes" };
    case "knowledge.capture":
      return { kind: "knowledge", label: "Knowledge", href: id ? `/m/knowledge/${id}` : "/m/knowledge" };
    case "ideas.capture":
      return { kind: "idea", label: "Idea", href: id ? `/m/ideas/${id}` : "/m/ideas" };
    default:
      return null;
  }
}

export async function triageInboxItem(itemId: string): Promise<void> {
  const [item] = await db
    .select()
    .from(inboxItems)
    .where(eq(inboxItems.id, itemId));
  if (!item || item.status === "triaged") return;

  const set = async (patch: Record<string, unknown>) => {
    await db.update(inboxItems).set(patch).where(eq(inboxItems.id, itemId));
    await sql.notify("inbox_changed", itemId);
  };

  try {
    await set({ status: "triaging", error: null });
    const route = await resolveRoute("inbox.triage");
    const { renderMemoryContext } = await import("@/core/memory");
    // Lazy import — tool-registry ↔ module manifests would otherwise cycle at
    // module-evaluation time.
    const { getToolsByNames } = await import("@/core/ai/tool-registry");

    let finalText = "";
    let usedTool: string | null = null;
    let toolResult: unknown = null;
    for await (const event of route.provider.run({
      system: [
        "You are the inbox triage of apOS, the user's Agentic Personalized Operating System.",
        "STEP 1 — is this a STATUS UPDATE about something that already exists, not a new item? Signals: 'I finished/did/completed X', 'done with Y', 'started on Z', 'X is blocked/on hold'. If so:",
        "  • Call tasks.list with a distinctive keyword from the input as `search` (e.g. a project or noun — not filler words) to find the task it refers to. Each result carries a short `ref`. Pick the best-matching NOT-done task.",
        "  • If you find it, update it with tasks.setStatus using that task's `ref` (never an id) — 'done' when completed/finished, 'doing' when started. Do NOT create a new task for a completion report.",
        "  • Only if no existing task plausibly matches, fall through to STEP 2.",
        "STEP 2 — otherwise CREATE exactly one item:",
        "  • actionable to-do → tasks.create (clean imperative title; set priority/dueAt if implied)",
        "  • URL/repo/video/quote worth keeping → knowledge.capture (pass input through; add why it matters)",
        "  • a product/business/feature idea or 'what if…' concept → ideas.capture",
        "  • longer thought or journal-style note → notes.create (give it a real title)",
        "  • something happening at a specific date/time → tasks.create with that dueAt (we do NOT auto-write the calendar)",
        "Use at most ONE create OR ONE status update (tasks.list to find it doesn't count). If it's pure noise, use no tool. Then answer with ONE short sentence describing what you did — name the task and its new status if you updated one.",
        `Current date-time: ${new Date().toISOString()}`,
        "",
        await renderMemoryContext(),
      ].join("\n"),
      messages: [{ role: "user", content: `Captured input:\n${item.input}` }],
      tools: getToolsByNames(TRIAGE_TOOLS),
      toolCtx: { db },
      model: route.model,
      maxTurns: 6,
    })) {
      if (event.type === "done") finalText = event.text;
      if (event.type === "error") throw new Error(event.message);
      // Remember the routing tool + its result (id of the created item).
      if (event.type === "tool_call") usedTool = event.name;
      if (event.type === "tool_result") toolResult = event.result;
    }

    // The Agent SDK serializes a tool's return value to a JSON string in the
    // tool-result block, so parse it back before reading the created item's id.
    const resultObj =
      typeof toolResult === "string" ? safeJsonParse(toolResult) : toolResult;
    const dest = usedTool ? routeFor(usedTool, resultObj) : null;
    const triageData = {
      summary: finalText.slice(0, 500) || "routed",
      ...(dest ? { route: dest } : {}),
    };
    await set({ status: "triaged", triage: triageData });

    // Slack-captured items get an in-thread confirmation of how/where they
    // were filed. No-op for manual captures; never breaks triage.
    if (item.source?.startsWith("slack:")) {
      const r = (resultObj ?? {}) as {
        created?: { id?: string };
        captured?: { id?: string };
        id?: string;
      };
      const { confirmSlackCapture } = await import("./slack-capture");
      await confirmSlackCapture({
        source: item.source,
        input: item.input,
        summary: finalText,
        route: dest,
        createdId: r.created?.id ?? r.captured?.id ?? r.id ?? null,
      }).catch(() => {});
    }

    // Post-handling audit: a LOCAL LLM re-reads the capture + what triage did
    // and decides whether it was handled properly → completed, else failed.
    const handling = dest
      ? `Filed as ${dest.label}${finalText ? ` — ${finalText.slice(0, 300)}` : ""}`
      : `Left in the inbox, no item created${finalText ? ` — ${finalText.slice(0, 300)}` : ""}`;
    const { verifyHandling } = await import("./verify");
    const verified = await verifyHandling(item.input, handling);
    await set({
      status: verified.ok ? "completed" : "failed",
      triage: { ...triageData, verified },
    });
    if (!verified.ok) await raiseFailedCaptureCard(item.input);
  } catch (e) {
    // A triage crash is itself a handling failure.
    await set({ status: "failed", error: String(e).slice(0, 400) });
    await raiseFailedCaptureCard(item.input);
  }
}

/** A capture that failed to file must not sit silent until the user happens to
 *  open Inbox — raise ONE self-deduping "Needs you" card pointing there. */
async function raiseFailedCaptureCard(input: string): Promise<void> {
  try {
    const { insertAttentionItem } = await import("@/modules/today/core");
    await insertAttentionItem({
      type: "do",
      title: `Capture didn't file: “${input.slice(0, 80)}${input.length > 80 ? "…" : ""}”`,
      body: "The AI triage couldn't route this capture. Retry it (or file it by hand) in the Inbox.",
      source: "inbox",
      urgency: 12,
      href: "/m/inbox",
      dedupeKey: "inbox:failed-captures",
    });
  } catch {
    // surfacing is best-effort — the item itself is already marked failed
  }
}

export const inboxJobs: ModuleJob[] = [
  { channel: "inbox_triage", handle: (payload) => triageInboxItem(payload) },
];
