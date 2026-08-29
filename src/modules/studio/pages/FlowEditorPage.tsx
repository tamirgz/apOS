import Link from "next/link";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { FlowCanvas } from "../components/FlowCanvas";
import {
  getFlow,
  latestRunView,
  listAgentOptions,
  listFlowOptions,
  listRecentRuns,
} from "../queries";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function FlowEditorPage({ params }: ModuleRouteProps) {
  const id = params[0];
  const flow = UUID_RE.test(id) ? await getFlow(id) : null;

  if (!flow) {
    return (
      <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          flow not found
        </p>
        <Link
          href="/m/studio"
          className="mt-2 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
        >
          back to studio
        </Link>
      </GlassPanel>
    );
  }

  const [agents, flowOptions, trace, recentRuns] = await Promise.all([
    listAgentOptions(),
    listFlowOptions(flow.id),
    latestRunView(flow.id),
    listRecentRuns(flow.id),
  ]);
  return (
    <FlowCanvas
      flow={{
        id: flow.id,
        name: flow.name,
        graph: flow.graph,
        trigger: flow.trigger ?? { kind: "manual" },
        enabled: flow.enabled,
      }}
      agents={agents}
      flows={flowOptions}
      trace={trace}
      recentRuns={recentRuns}
    />
  );
}
