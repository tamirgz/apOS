"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NotebookPen, Plus } from "lucide-react";
import { createNote } from "@/modules/notes/actions";
import type { Note } from "@/modules/notes/schema";

/** Notes linked to this project, plus a one-click "new note here". */
export function ProjectNotes({
  projectId,
  notes,
}: {
  projectId: string;
  notes: Note[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <section className="mt-6">
      <header className="mb-3 flex items-center gap-2 px-1">
        <NotebookPen className="size-3.5 text-violet" />
        <h2 className="font-display text-sm font-medium uppercase tracking-[0.2em] text-ink-dim">
          Notes
        </h2>
        <span className="font-mono text-xs tabular-nums text-ink-faint">
          {notes.length}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const row = await createNote({
                projectRefs: [`projects:${projectId}`],
              });
              router.push(`/m/notes/${row.id}`);
            })
          }
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-violet transition hover:bg-violet/25 disabled:opacity-40"
        >
          <Plus className="size-3" />
          {pending ? "…" : "new note"}
        </button>
      </header>

      {notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          no notes linked yet
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {notes.map((n) => (
            <Link
              key={n.id}
              href={`/m/notes/${n.id}`}
              className="group glass flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 transition hover:bg-white/4"
            >
              <NotebookPen className="size-3.5 shrink-0 text-violet" />
              <span className="flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
                {n.title}
              </span>
              <span
                suppressHydrationWarning
                className="font-mono text-[9px] uppercase tracking-widest text-ink-faint"
              >
                {n.updatedAt.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
