"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { FolderKanban, Plus } from "lucide-react";
import { createNote } from "../actions";
import type { Note } from "../schema";

function NewNoteButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const row = await createNote();
          router.push(`/m/notes/${row.id}`);
        })
      }
      className="flex items-center gap-1.5 rounded-lg bg-violet/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-violet transition hover:bg-violet/25 disabled:opacity-40"
    >
      <Plus className="size-3.5" />
      {pending ? "…" : "new note"}
    </button>
  );
}

function snippet(body: string) {
  return body.replace(/[#>*`_\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

function NoteCard({
  note,
  index,
  projectName,
}: {
  note: Note;
  index: number;
  projectName?: string;
}) {
  const excerpt = snippet(note.body);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        type: "spring",
        stiffness: 420,
        damping: 34,
        delay: index * 0.04,
      }}
    >
      <Link
        href={`/m/notes/${note.id}`}
        className="group glass flex h-full flex-col gap-2.5 rounded-xl p-4 transition hover:bg-white/4 hover:glass-edge"
      >
        <h3 className="font-display text-sm font-medium leading-snug text-ink transition group-hover:text-glow">
          {note.title}
        </h3>
        {excerpt && (
          <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-ink-dim">
            {excerpt}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {projectName && (
            <span className="flex items-center gap-1 rounded border border-solar/25 bg-solar/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-solar">
              <FolderKanban className="size-2.5" />
              <span className="max-w-28 truncate normal-case tracking-normal">
                {projectName}
              </span>
            </span>
          )}
          {(note.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="rounded border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-violet"
            >
              {tag}
            </span>
          ))}
          <span
            suppressHydrationWarning
            className="ml-auto font-mono text-[9px] uppercase tracking-widest text-ink-faint"
          >
            {note.updatedAt.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

export function NotesGrid({
  notes,
  projectNames = {},
}: {
  notes: Note[];
  /** projectId → name, for the card badge. */
  projectNames?: Record<string, string>;
}) {
  return (
    <div>
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2 px-1">
          <span className="dot" style={{ color: "var(--color-violet)" }} />
          <h2 className="font-display text-sm font-medium uppercase tracking-[0.2em] text-ink-dim">
            Logbook
          </h2>
          <span className="ml-2 font-mono text-xs tabular-nums text-ink-faint">
            {notes.length}
          </span>
        </div>
        <NewNoteButton />
      </header>
      {notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-16 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          empty — start a new note
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((n, i) => (
            <NoteCard
              key={n.id}
              note={n}
              index={i}
              projectName={(() => {
                const names = (n.projectRefs ?? [])
                  .map((r) => projectNames[r.split(":")[1]])
                  .filter(Boolean);
                if (names.length === 0) return undefined;
                return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
              })()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
