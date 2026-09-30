import { ArrowLeft } from "lucide-react";
import Link from "next/link";
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
        <Link
          href="/m/agents"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          back to agents
        </Link>
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
