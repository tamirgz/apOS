import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { approvals } from "@/core/db/schema/approvals";
import { serverModules } from "@/modules/registry.server";
import { AgentsList } from "../components/AgentsList";
import { ApprovalsPanel } from "../components/ApprovalsPanel";
import { ExternalReports } from "../components/ExternalReports";
import { RunQueuePanel } from "../components/RunQueuePanel";
import { externalReports } from "../schema";
import { getReportsDir } from "../external";
import { getRunQueue, listAgentsWithLatestRun } from "../queries";

export async function AgentsPage() {
  const [items, queue, pending, reports, dropboxDir] = await Promise.all([
    listAgentsWithLatestRun(),
    getRunQueue(),
    db
      .select()
      .from(approvals)
      .where(eq(approvals.status, "pending"))
      .orderBy(asc(approvals.createdAt)),
    db
      .select()
      .from(externalReports)
      .orderBy(desc(externalReports.reportedAt))
      .limit(15),
    getReportsDir(),
  ]);
  const templates = serverModules.flatMap((m) =>
    m.agentTemplates.map((t) => ({ ...t, moduleId: m.id })),
  );
  return (
    <>
      <ApprovalsPanel pending={pending} />
      <RunQueuePanel state={queue} />
      <AgentsList items={items} templates={templates} />
      <ExternalReports reports={reports} dropboxDir={dropboxDir} />
    </>
  );
}
