import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { cn } from "@/core/ui/cn";
import type { AIProviderId } from "@/core/db/schema/ai-routes";
import { COST_REASON } from "./UsagePanel";

type CostRow = {
  name: string;
  provider?: AIProviderId;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  unpriced: number;
} & Record<string, unknown>;

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function CostTable({ title, rows }: { title: string; rows: CostRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          <th className="pb-2 text-left font-normal">{title}</th>
          <th className="pb-2 text-right font-normal">calls</th>
          <th className="pb-2 text-right font-normal">tok in</th>
          <th className="pb-2 text-right font-normal">tok out</th>
          <th className="pb-2 text-right font-normal">cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-t border-white/4">
            <td className="py-1.5 text-ink-dim">{r.name}</td>
            <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink">{r.calls}</td>
            <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">{fmt(r.tokens_in)}</td>
            <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">{fmt(r.tokens_out)}</td>
            <td className="py-1.5 text-right">
              <span
                title={
                  r.unpriced
                    ? `${r.unpriced} call(s) on a metered model with no known price — not counted`
                    : r.provider
                      ? COST_REASON[r.provider]
                      : undefined
                }
                className={cn("font-mono text-xs tabular-nums", r.cost > 0 ? "text-solar" : "text-ink-faint")}
              >
                {usd(r.cost)}
                {r.unpriced ? " +?" : ""}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 30-day model cost from the usage ledger (one row per generation), per
 *  provider and per agent / chat route / other caller. */
export async function CostPanel() {
  const [byProvider, byCaller] = await Promise.all([
    db.execute<CostRow>(dsql`
      select provider as name, provider,
             count(*)::int as calls,
             coalesce(sum(tokens_in), 0)::int as tokens_in,
             coalesce(sum(tokens_out), 0)::int as tokens_out,
             coalesce(sum(cost_usd), 0)::float8 as cost,
             count(*) filter (where cost_usd is null)::int as unpriced
        from usage_ledger
       where ts > now() - interval '30 days'
       group by provider
       order by cost desc, tokens_out desc
    `),
    db.execute<CostRow>(dsql`
      select case
               when l.agent_id is not null then coalesce(a.name, '(deleted agent)')
               when l.parent_kind = 'chat' then 'chat · ' || coalesce(l.task_key, l.label)
               when l.label = '' then l.source
               else l.source || ' · ' || l.label
             end as name,
             count(*)::int as calls,
             coalesce(sum(l.tokens_in), 0)::int as tokens_in,
             coalesce(sum(l.tokens_out), 0)::int as tokens_out,
             coalesce(sum(l.cost_usd), 0)::float8 as cost,
             count(*) filter (where l.cost_usd is null)::int as unpriced
        from usage_ledger l
        left join agents a on a.id = l.agent_id
       where l.ts > now() - interval '30 days'
       group by 1
       order by cost desc, tokens_out desc
       limit 15
    `),
  ]);
  const total = [...byProvider].reduce((s, r) => s + r.cost, 0);

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        model cost — last 30 days · {usd(total)}
      </p>
      <div className="glass flex flex-col gap-4 rounded-xl p-3">
        {byProvider.length === 0 ? (
          <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            no model calls recorded yet
          </p>
        ) : (
          <>
            <CostTable title="provider" rows={[...byProvider]} />
            <CostTable title="agent / caller" rows={[...byCaller]} />
          </>
        )}
      </div>
      <p className="px-1 font-mono text-[9px] leading-relaxed text-ink-faint">
        Priced per call from the gateways&apos; own price lists. Local models, ‘:free’ models, the
        fail-closed-free NVIDIA tier and your flat-rate Claude Max plan are $0. Hover a cost for why;
        “+?” marks calls on a metered model with no known price.
      </p>
    </div>
  );
}
