import Link from "next/link";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { ACTIVE_STATUSES, priorityRank, tasks } from "../schema";
import { withIdentifiers } from "../core";
import { STATUS_META, plainTitle } from "../states";
import { cn } from "@/core/ui/cn";

const PRIORITY_COLOR = {
  urgent: "text-flare",
  high: "text-flare",
  medium: "text-solar",
  low: "text-ink-faint",
} as const;

export async function UpNextWidget() {
  // Committed work only (not the backlog): in-progress first, then priority.
  const rows = await withIdentifiers(
    db,
    await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, [...ACTIVE_STATUSES]))
      .orderBy(asc(sql`case ${tasks.status} when 'review' then 0 when 'doing' then 1 else 2 end`), priorityRank, asc(tasks.sortOrder))
      .limit(5),
  );

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
              "font-mono text-[9px] uppercase tracking-widest",
              PRIORITY_COLOR[t.priority],
            )}
          >
            ▲ {t.identifier ? `${t.identifier} · ` : ""}{STATUS_META[t.status].label}
          </span>
          <span className="line-clamp-2 text-[13px] leading-snug text-ink-dim transition group-hover:text-ink">
            {plainTitle(t.title)}
          </span>
        </Link>
      ))}
    </div>
  );
}
