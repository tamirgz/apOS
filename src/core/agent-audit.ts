/**
 * One write path for the agent decision trail (agent_audit). Best-effort by
 * design: auditing must never change the outcome of the thing it records.
 */
import { db } from "@/core/db/client";
import { agentAudit } from "@/core/db/schema/agents";

export async function auditAgent(entry: {
  agentId?: string | null;
  agentName: string;
  runId?: string | null;
  event: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(agentAudit).values({
      agentId: entry.agentId ?? null,
      agentName: entry.agentName,
      runId: entry.runId ?? null,
      event: entry.event,
      detail: entry.detail ?? null,
    });
  } catch {
    // best-effort — never break the audited action
  }
}
