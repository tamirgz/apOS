"use server";

import { Cron } from "croner";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, sql } from "@/core/db/client";
import { isUniqueViolation } from "@/core/db/errors";
import {
  agentLedger,
  agentRuns,
  agents,
} from "@/core/db/schema/agents";
import type { AIProviderId } from "@/core/db/schema/ai-routes";
import { serverModules } from "@/modules/registry.server";

function validateSchedule(schedule: string | null | undefined) {
  if (!schedule) return null;
  try {
    new Cron(schedule).stop();
    return schedule;
  } catch {
    throw new Error(`invalid cron pattern: "${schedule}"`);
  }
}

async function notifyChanged(id: string) {
  await sql.notify("agents_changed", id);
  revalidatePath("/m/agents");
  revalidatePath(`/m/agents/${id}`);
  revalidatePath("/");
}

export async function createAgent(input: {
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  schedule?: string | null;
  provider?: AIProviderId | null;
  model?: string | null;
  fallbackModel?: string | null;
  successTool?: string | null;
  turnBudget?: number | null;
  isolated?: boolean;
}) {
  const [row] = await db
    .insert(agents)
    .values({
      name: input.name.trim() || "Unnamed agent",
      description: input.description?.trim() || null,
      prompt: input.prompt,
      tools: input.tools ?? [],
      schedule: validateSchedule(input.schedule),
      // A per-agent provider/model override pins periodic agents to a free
      // local model; without both, the run falls back to the agent.default route.
      provider: input.provider ?? null,
      model: input.model ?? null,
      // Local Ollama model to retry on if a cloud primary fails on connectivity.
      fallbackModel: input.fallbackModel ?? null,
      successTool: input.successTool ?? null,
      turnBudget: input.turnBudget ?? null,
      isolated: input.isolated ?? false,
    })
    .returning();
  await notifyChanged(row.id);
  return row;
}

export async function createFromTemplate(templateId: string) {
  const template = serverModules
    .flatMap((m) => m.agentTemplates)
    .find((t) => t.id === templateId);
  if (!template) throw new Error(`unknown template: ${templateId}`);
  return createAgent({
    name: template.name,
    description: template.description,
    prompt: template.defaultPrompt,
    tools: template.defaultTools,
    schedule: template.defaultSchedule,
    provider: template.defaultProvider ?? null,
    model: template.defaultModel ?? null,
    fallbackModel: template.defaultFallbackModel ?? null,
    successTool: template.defaultSuccessTool ?? null,
    turnBudget: template.defaultTurnBudget ?? null,
    isolated: template.defaultIsolated ?? false,
  });
}

export async function updateAgent(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    prompt: string;
    tools: string[];
    schedule: string | null;
    enabled: boolean;
    provider: AIProviderId | null;
    model: string | null;
    fallbackModel: string | null;
    successTool: string | null;
    turnBudget: number | null;
  }>,
) {
  if ("schedule" in patch) patch.schedule = validateSchedule(patch.schedule);
  const [row] = await db
    .update(agents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();
  await notifyChanged(id);
  return row;
}

export async function deleteAgent(id: string) {
  await db.delete(agentRuns).where(eq(agentRuns.agentId, id));
  await db.delete(agentLedger).where(eq(agentLedger.agentId, id));
  await db.delete(agents).where(eq(agents.id, id));
  await notifyChanged(id);
}

export async function decideApproval(id: string, approved: boolean) {
  const { approvals } = await import("@/core/db/schema/approvals");
  // Guard on status='pending': a double click (or a replayed NOTIFY) on an
  // already-executed approval must never flip it back to 'approved' and
  // re-execute the side-effecting tool.
  const rows = await db
    .update(approvals)
    .set({
      status: approved ? "approved" : "rejected",
      decidedAt: new Date(),
    })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (rows.length === 0) return;
  await sql.notify("approvals_changed", id);
  if (approved) await sql.notify("approval_decisions", id);
  revalidatePath("/m/agents");
}

export async function requestRun(
  agentId: string,
): Promise<{ runId?: string; alreadyRunning?: boolean }> {
  try {
    const [row] = await db
      .insert(agentRuns)
      .values({ agentId, trigger: "manual", status: "queued" })
      .returning({ id: agentRuns.id });
    await sql.notify("run_requests", row.id);
    revalidatePath("/m/agents");
    revalidatePath(`/m/agents/${agentId}`);
    return { runId: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { alreadyRunning: true };
    throw e;
  }
}
