import Link from "next/link";
import { asc, ne } from "drizzle-orm";
import { db } from "@/core/db/client";
import { priorityRank, tasks } from "../schema";
import { cn } from "@/core/ui/cn";

const PRIORITY_COLOR = {
  high: "text-flare",
  medium: "text-solar",
  low: "text-ink-faint",
} as const;

export async function UpNextWidget() {
  const rows = await db
    .select()
    .from(tasks)
    .where(ne(tasks.status, "done"))
    .orderBy(priorityRank, asc(tasks.createdAt))
    .limit(5);

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
            ▲ {t.status}
          </span>
          <span className="line-clamp-2 text-[13px] leading-snug text-ink-dim transition group-hover:text-ink">
            {t.title}
          </span>
        </Link>
      ))}
    </div>
  );
}
