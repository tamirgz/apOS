import { asc } from "drizzle-orm";
import { db } from "@/core/db/client";
import { agents } from "@/core/db/schema/agents";
import { SectionTabs } from "@/core/ui/SectionTabs";
import { AgentModelsPanel } from "../components/AgentModelsPanel";

/** Agents · Models — the provider/model each agent runs on. */
export async function AgentModelsPage() {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      schedule: agents.schedule,
      enabled: agents.enabled,
      provider: agents.provider,
      model: agents.model,
    })
    .from(agents)
    .orderBy(asc(agents.name));
  return (
    <div className="max-w-4xl">
      <SectionTabs section="automation" />
      <AgentModelsPanel agents={rows} />
    </div>
  );
}
