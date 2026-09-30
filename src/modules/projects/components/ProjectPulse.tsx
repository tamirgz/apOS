"use client";

import Link from "next/link";
import { Diamond } from "lucide-react";
import { shortDate } from "@/core/ui/time";
import { useNow } from "@/core/ui/useNow";
import type { WorkItem } from "@/modules/tasks/core";
import type { CycleSummary } from "@/modules/tasks/cycles";
import type { WorkFeature } from "@/modules/tasks/queries";
import { cycleMetrics, modulePct, type ModuleStats } from "@/modules/tasks/stats";
import { Burn, CycleBar } from "@/modules/tasks/components/cycle-kit";

const DAY = 86_400_000;

/**
 * The Overview's view of the work: the running cycle in miniature and the
 * live modules nearest their target. Each links into its tab. The page picks
 * the pieces (see pulseProps) so only the cycle's items cross to the client.
 */
export function ProjectPulse({
  cycle,
  cycleItems,
  blocked,
  modules,
}: {
  cycle: CycleSummary | null;
  cycleItems: WorkItem[];
  blocked: string[];
  modules: { f: WorkFeature; s?: ModuleStats }[];
}) {
  const now = useNow();
  const m = cycle ? cycleMetrics(cycle, cycleItems, blocked, now) : null;

  return (
    <section aria-label="Cycle and modules" className="glass flex flex-col gap-4 rounded-2xl p-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="wk-sec-h">Cycle</h3>
          <Link href="?tab=cycles" className="ml-auto text-[11.5px] text-ink-faint transition hover:text-ink">
            All cycles
          </Link>
        </div>
        {cycle && m ? (
          <Link href={`?tab=cycles&cycle=${cycle.id}`} className="group flex flex-col gap-2 rounded-xl border border-ion/10 bg-ink/[0.03] p-3 transition hover:border-ion/25">
            <span className="flex items-baseline gap-2">
              <span dir="auto" className="min-w-0 truncate font-display text-[15px] text-ink transition group-hover:text-plasma">
                {cycle.name}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                {m.daysLeft}d left · {m.pct}%
              </span>
            </span>
            <CycleBar m={m} />
            <Burn c={cycle} height={44} />
            <span className="flex justify-between font-mono text-[10.5px] tabular-nums text-ink-faint">
              <span>{shortDate(cycle.startsAt)}</span>
              <span>{shortDate(cycle.endsAt)}</span>
            </span>
          </Link>
        ) : (
          <p className="text-[12.5px] text-ink-faint">
            No cycle running.{" "}
            <Link href="?tab=cycles" className="text-ink-dim underline decoration-dotted underline-offset-2 transition hover:text-ink">
              Plan one
            </Link>{" "}
            to get a burndown and a pace read.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="wk-sec-h">Modules</h3>
          <Link href="?tab=modules" className="ml-auto text-[11.5px] text-ink-faint transition hover:text-ink">
            All modules
          </Link>
        </div>
        {modules.length === 0 ? (
          <p className="text-[12.5px] text-ink-faint">No live modules. Group items into a module to track it here.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {modules.map(({ f, s }) => {
              const pct = modulePct(s);
              const late = !!f.targetAt && +new Date(f.targetAt) + DAY < now;
              return (
                <li key={f.id}>
                  <Link href={`?tab=modules&module=${f.id}`} className="group flex flex-col gap-1">
                    <span className="flex items-center gap-2 text-[13px]">
                      <Diamond className="size-3 shrink-0 text-solar" fill="currentColor" fillOpacity={0.25} aria-hidden />
                      <span dir="auto" className="min-w-0 flex-1 truncate text-ink-dim transition group-hover:text-ink">
                        {f.name}
                      </span>
                      <span className={late ? "shrink-0 font-mono text-[11px] text-flare" : "shrink-0 font-mono text-[11px] text-ink-faint"}>
                        {f.targetAt ? `${shortDate(f.targetAt)}${late ? " · late" : ""} · ` : ""}
                        {s?.total ? `${pct}%` : "—"}
                      </span>
                    </span>
                    <span className="wk-bar !h-[5px]">
                      <b style={{ width: `${pct}%`, background: late ? "var(--color-flare)" : "var(--color-plasma)" }} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
