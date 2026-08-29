import { listAgentOptions, listFlows } from "../queries";
import { FlowLibrary } from "../components/FlowLibrary";

/** Studio root — the flow library. */
export async function StudioPage() {
  const [flows, agents] = await Promise.all([listFlows(), listAgentOptions()]);
  return <FlowLibrary flows={flows} agents={agents} />;
}
