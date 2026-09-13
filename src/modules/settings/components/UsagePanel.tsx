import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { isCloudProvider, resolveRoute } from "@/core/ai/routing";
import { cn } from "@/core/ui/cn";
import type { AIProviderId } from "@/core/db/schema/ai-routes";

type UsageRow = {
  agent_name: string;
  provider: AIProviderId | null;
  model: string | null;
  runs: number;
  failures: number;
  tokens_in: number;
  tokens_out: number;
} & Record<string, unknown>;

/** Why this provider costs $0 in THIS app specifically (not in general). */
const COST_REASON: Record<AIProviderId, string> = {
  ollama: "local — runs on this machine, no billing at all",
  mlx: "local — Apple MLX runtime (mlx_lm.server) on this machine, no billing at all",
  nvidia: "NVIDIA free tier — the agent layer refuses any model that isn't confirmed $0 (fail-closed)",
  anthropic: "Claude Max subscription — flat-rate, no per-token metering (no API key is configured)",
  gemini: "Google AI Studio API key — METERED, billed per-token by Google (free tier available)",
  openrouter: "OpenRouter API key — METERED per-token, but models ending ':free' cost $0",
  tokenharbor: "Token Harbor API key — METERED per-token, but models ending ':free' cost $0",
};

/** Per-agent token/run aggregates for the last 30 days, plus which mode (cloud/local) each currently runs on. */
export async function UsagePanel() {
  const [rows, defaultRoute] = await Promise.all([
    db.execute<UsageRow>(dsql`
      select coalesce(a.name, '(deleted agent)') as agent_name,
             a.provider as provider,
             a.model as model,
             count(*)::int as runs,
             count(*) filter (where r.status in ('failed','timed_out'))::int as failures,
             coalesce(sum(r.tokens_in), 0)::int as tokens_in,
             coalesce(sum(r.tokens_out), 0)::int as tokens_out
        from agent_runs r
        left join agents a on a.id = r.agent_id
       where r.created_at > now() - interval '30 days'
       group by 1, 2, 3
       order by tokens_out desc
    `),
    // What an agent with no pinned provider/model actually falls back to.
    resolveRoute("agent.default"),
  ]);
  const list = [...rows];
  const fmt = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        agent usage — last 30 days
      </p>
      <div className="glass rounded-xl p-3">
        {list.length === 0 ? (
          <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            no runs yet
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                <th className="pb-2 text-left font-normal">agent</th>
                <th className="pb-2 text-center font-normal">mode</th>
                <th className="pb-2 text-right font-normal">runs</th>
                <th className="pb-2 text-right font-normal">fails</th>
                <th className="pb-2 text-right font-normal">tok in</th>
                <th className="pb-2 text-right font-normal">tok out</th>
                <th className="pb-2 text-right font-normal">cost</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const effProvider = r.provider ?? defaultRoute.providerId;
                const effModel = r.model ?? defaultRoute.model;
                const cloud = isCloudProvider(effProvider);
                return (
                  <tr key={`${r.agent_name}:${effProvider}:${effModel}`} className="border-t border-white/4">
                    <td className="py-1.5 text-ink-dim">{r.agent_name}</td>
                    <td className="py-1.5 text-center">
                      <span
                        title={`${effProvider} / ${effModel}${r.provider ? "" : " (default route, no override)"}`}
                        className={cn(
                          "inline-flex size-5 items-center justify-center rounded-md border font-mono text-[9px] font-bold",
                          cloud
                            ? "border-solar/40 bg-solar/10 text-solar"
                            : "border-plasma/40 bg-plasma/10 text-plasma",
                        )}
                      >
                        {cloud ? "C" : "L"}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink">
                      {r.runs}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums">
                      <span className={r.failures > 0 ? "text-flare" : "text-ink-faint"}>
                        {r.failures}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">
                      {fmt(r.tokens_in)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">
                      {fmt(r.tokens_out)}
                    </td>
                    <td className="py-1.5 text-right">
                      <span
                        title={COST_REASON[effProvider]}
                        className="font-mono text-xs tabular-nums text-ink-faint"
                      >
                        {effProvider === "gemini" || effProvider === "openrouter" || effProvider === "tokenharbor"
                          ? "meter"
                          : "$0"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="px-1 font-mono text-[9px] leading-relaxed text-ink-faint">
        C = cloud · L = local (Ollama, on this machine). Local models, the
        fail-closed-free NVIDIA tier, and your flat-rate Claude Max plan are $0;
        Gemini and non-‘:free’ OpenRouter models are metered by the provider.
        Hover a cost cell for why.
      </p>
    </div>
  );
}
