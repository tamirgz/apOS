"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NotebookPen, Plus } from "lucide-react";
import { act } from "@/core/ui/feedback";
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
    <section id="project-notes" aria-label="Notes" className="glass flex scroll-mt-24 flex-col gap-2.5 rounded-2xl p-5">
      <header className="flex items-center gap-2">
        <h3 className="wk-sec-h">
          <NotebookPen className="size-3.5 text-violet" /> Notes <span className="tabular-nums">{notes.length}</span>
        </h3>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await act(
                () => createNote({ projectRefs: [`projects:${projectId}`] }),
                { failed: "Couldn't create the note" },
              );
              if (!r.ok) return;
              router.push(`/m/notes/${r.value.id}`);
            })
          }
          className="wk-btn ml-auto !py-1 text-xs"
        >
          <Plus className="size-3.5" />
          {pending ? "Creating…" : "New note"}
        </button>
      </header>

      {notes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ion/12 px-3 py-5 text-center text-[12.5px] text-ink-faint">
          No notes linked yet.
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {notes.map((n) => (
            <li key={n.id}>
              <Link
                href={`/m/notes/${n.id}`}
                className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-ink/4"
              >
                <NotebookPen className="size-3.5 shrink-0 text-ink-faint transition group-hover:text-violet" />
                <span dir="auto" className="min-w-0 flex-1 truncate text-[13px] text-ink-dim transition group-hover:text-ink">
                  {n.title || "Untitled"}
                </span>
                <span suppressHydrationWarning className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                  {n.updatedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
