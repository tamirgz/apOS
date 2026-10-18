// The ONE place a tool call executes. Every caller — the provider tool loops
// (agent runs, chat, the native Workbench executor, sub-tasks), Studio flow tool
// nodes, the MCP server and executeApproval — goes through invokeTool, so an
// approval-tier tool can't run unattended by being reached some other way.
//
// Kept apart from tool-registry.ts on purpose: the providers import this, and
// the registry pulls in every module manifest (which import the providers).
import { randomUUID } from "node:crypto";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { stabilizeRefs } from "./refs";

/** Who a parked call is credited to on the approval card. */
export interface ApprovalOrigin {
  agentId: string;
  runId: string;
  agentName: string;
}

/** Appended to an approval-tier tool's description wherever it can be parked. */
export const APPROVAL_NOTE =
  "NOTE: this action requires the user's approval — calling it queues the request; it executes only after the user approves.";

/** The tool list a model sees in an unattended context: approval-tier tools say so. */
export function withApprovalNotes(tools: AiToolDef[]): AiToolDef[] {
  return tools.map((t) =>
    t.risk === "approval" ? { ...t, description: `${t.description} ${APPROVAL_NOTE}` } : t,
  );
}

/**
 * Run a tool call with already-parsed input. A safe tool executes. An
 * approval-tier tool executes only when the user is present (chat) or has
 * approved this exact call; anywhere else it is parked in `approvals` and the
 * caller gets `{ pending_approval }` back.
 */
export async function invokeTool(
  tool: AiToolDef,
  input: unknown,
  ctx: AiToolContext,
): Promise<unknown> {
  if (tool.risk !== "approval" || ctx.userPresent || ctx.approved) {
    return tool.execute(input, ctx);
  }
  return parkApproval(tool, input, ctx);
}

async function parkApproval(tool: AiToolDef, raw: unknown, ctx: AiToolContext) {
  const { db, sql } = await import("@/core/db/client");
  const { approvals } = await import("@/core/db/schema/approvals");
  const { notify } = await import("@/core/notify");
  // No origin = a caller that didn't say who it is; still park (fail closed).
  const anon = randomUUID();
  const origin: ApprovalOrigin = ctx.approvalOrigin ?? {
    agentId: anon,
    runId: ctx.agentRunId ?? anon,
    agentName: ctx.agentName ?? "unattended run",
  };
  // Park stable ids, not this run's handles — they're gone by approval time.
  const input = stabilizeRefs(ctx, raw);
  const [row] = await db
    .insert(approvals)
    .values({ ...origin, toolName: tool.name, input: input ?? {} })
    .returning();
  await sql.notify("approvals_changed", row.id);
  await notify({
    title: `Approval needed: ${tool.name}`,
    body: `"${origin.agentName}" wants to run ${tool.name} with:\n${JSON.stringify(input, null, 2).slice(0, 400)}`,
    level: "warn",
    source: `agent:${origin.agentName}`,
    href: "/m/agents",
  });
  return {
    pending_approval: row.id,
    note: "Queued for the user's approval; it will execute once approved. Mention this in your report.",
  };
}
