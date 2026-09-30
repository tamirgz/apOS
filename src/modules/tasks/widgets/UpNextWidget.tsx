import Link from "next/link";
import { and, asc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { ACTIVE_STATUSES, cycles, priorityRank, tasks } from "../schema";
import { withIdentifiers } from "../core";
import { STATUS_META, displayTitle } from "../states";
import { cn } from "@/core/ui/cn";

const PRIORITY_COLOR = {
  urgent: "text-flare",
  high: "text-flare",
  medium: "text-solar",
  low: "text-ink-faint",
} as const;

const DAY = 86_400_000;

/** "overdue 3d" / "due today" / "due in 2d" — only when it's close. */
function dueLabel(dueAt: Date | null, now: number): string | null {
  if (!dueAt) return null;
  const days = Math.floor((dueAt.getTime() - now) / DAY);
  if (days < 0) return `overdue ${-days}d`;
  if (days === 0) return "due today";
  return days <= 3 ? `due in ${days}d` : null;
}

export async function UpNextWidget() {
  const now = new Date();
  // Current cycles (derived from dates) — their items outrank the open pool.
  const current = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(and(lte(cycles.startsAt, now), gte(cycles.endsAt, now)));
  const cycleIds = current.map((c) => c.id);
  const inCycle = cycleIds.length
    ? sql`${tasks.cycleId} in (${sql.join(cycleIds.map((id) => sql`${id}`), sql`, `)})`
    : sql`false`;
  const soon = new Date(now.getTime() + 3 * DAY);

  // The work in play, committed items only (not the backlog): review, then
  // in progress, then overdue / due within 3 days, then the current cycle,
  // then priority.
  const rows = await withIdentifiers(
    db,
    await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
      .orderBy(
        asc(sql`case ${tasks.status} when 'review' then 0 when 'doing' then 1 else 2 end`),
        asc(sql`case when ${tasks.dueAt} is not null and ${tasks.dueAt} <= ${soon.toISOString()}::timestamptz then 0 else 1 end`),
        asc(sql`case when ${inCycle} then 0 else 1 end`),
        priorityRank,
        asc(tasks.sortOrder),
      )
      .limit(5),
  );
  const inCycleSet = new Set(cycleIds);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        queue clear — nothing pending
      </p>
    );
  }

  // Horizontal cells: reads as a "work queue" strip across the full-width
  // tier-1 slot (one column per next task), instead of a tall vertical list.
  return (
    <div className="grid h-full grid-cols-1 gap-px overflow-hidden rounded-lg bg-white/5 sm:grid-cols-2 lg:grid-cols-5">
      {rows.map((t) => (
        <Link
          key={t.id}
          href={`/m/tasks/${t.id}`}
          className="group flex flex-col gap-1.5 bg-abyss/60 p-3 transition hover:bg-white/4"
        >
          <span
            className={cn(
              "truncate font-mono text-[9px] uppercase tracking-widest",
              PRIORITY_COLOR[t.priority],
            )}
          >
            ▲ {t.identifier ? `${t.identifier} · ` : ""}{STATUS_META[t.status].label}
            {dueLabel(t.dueAt, now.getTime()) && (
              <span className="text-flare"> · {dueLabel(t.dueAt, now.getTime())}</span>
            )}
            {t.cycleId && inCycleSet.has(t.cycleId) && (
              <span className="text-ion"> · cycle</span>
            )}
          </span>
          <span className="line-clamp-2 text-[13px] leading-snug text-ink-dim transition group-hover:text-ink">
            {displayTitle(t)}
          </span>
        </Link>
      ))}
    </div>
  );
}
