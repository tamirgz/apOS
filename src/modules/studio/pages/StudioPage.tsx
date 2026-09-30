import { listAgentOptions, listFlows, listFlowStats } from "../queries";
import { templateCards } from "../templates";
import { FlowLibrary } from "../components/FlowLibrary";
import { SectionTabs } from "@/core/ui/SectionTabs";

/** Studio root — the flow library. */
export async function StudioPage() {
  const [flows, agents, statsMap] = await Promise.all([
    listFlows(),
    listAgentOptions(),
    listFlowStats(),
  ]);
  // Plain object so it serializes to the client component.
  const stats = Object.fromEntries(statsMap);
  return (
    <>
      <SectionTabs section="automation" />
      <FlowLibrary flows={flows} agents={agents} stats={stats} templates={templateCards()} />
    </>
  );
}
