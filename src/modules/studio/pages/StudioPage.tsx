import { listAgentOptions, listFlows, listFlowStats } from "../queries";
import { templateCards } from "../templates";
import { FlowLibrary } from "../components/FlowLibrary";

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
    <FlowLibrary flows={flows} agents={agents} stats={stats} templates={templateCards()} />
  );
}
