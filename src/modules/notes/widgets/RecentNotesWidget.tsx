import Link from "next/link";
import { desc } from "drizzle-orm";
import { db } from "@/core/db/client";
import { notes } from "../schema";

export async function RecentNotesWidget() {
  const rows = await db
    .select()
    .from(notes)
    .orderBy(desc(notes.updatedAt))
    .limit(4);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        no notes yet — start one
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((n) => (
        <li key={n.id}>
          <Link
            href={`/m/notes/${n.id}`}
            className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4"
          >
            <span className="font-mono text-[9px] text-violet">◆</span>
            <span className="flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
              {n.title}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              {n.updatedAt.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
