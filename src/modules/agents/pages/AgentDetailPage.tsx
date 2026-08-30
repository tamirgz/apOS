import type { ModuleRouteProps } from "@/core/modules/types.server";
import { getAllTools } from "@/core/ai/tool-registry";
import { resolveRoute } from "@/core/ai/routing";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { AgentDetail } from "../components/AgentDetail";
import { AuditTrail } from "../components/AuditTrail";
import { agentDoc } from "../agent-doc";
import { getAgent, listAgentAudit, listRuns } from "../queries";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function AgentDetailPage({ params }: ModuleRouteProps) {
  const id = params[0];
  const agent = UUID_RE.test(id) ? await getAgent(id) : null;

  if (!agent) {
    return (
      <GlassPanel className="px-8 py-16 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          agent not found
        </p>
      </GlassPanel>
    );
  }

  const [runs, defaultRoute, audit] = await Promise.all([
    listRuns(agent.id),
    // What this agent falls back to when it has no provider/model override.
    resolveRoute("agent.default"),
    listAgentAudit(agent.id),
  ]);
  const allTools = getAllTools().map((t) => t.name);
  const doc = agentDoc({
    name: agent.name,
    tools: agent.tools ?? [],
    prompt: agent.prompt ?? "",
  });
  return (
    <>
      <AgentDetail
        agent={agent}
        runs={runs}
        allTools={allTools}
        defaultRoute={{ providerId: defaultRoute.providerId, model: defaultRoute.model }}
        doc={doc}
      />
      <AuditTrail rows={audit} />
    </>
  );
}
