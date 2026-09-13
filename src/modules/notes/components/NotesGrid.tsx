"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { FolderKanban, Plus } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { categoryColor } from "@/modules/projects/components/categoryColor";
import { createNote } from "../actions";
import type { Note } from "../schema";

export interface ProjInfo {
  name: string;
  category: string | null;
  kind: string;
}

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

const UNFILED = "__unfiled__";

interface NoteGroup {
  key: string;
  label: string;
  color: string | null;
  kind: string;
  notes: Note[];
}

/** Group notes by the project/area they're filed under (the backbone). A
 *  multi-filed note appears under each filing; unfiled notes sink to their own
 *  section. Areas (standing life-domains) lead, then projects, each by size. */
function groupNotes(
  notes: Note[],
  info: Record<string, ProjInfo>,
): NoteGroup[] {
  const byId = new Map<string, NoteGroup>();
  const unfiled: Note[] = [];
  for (const n of notes) {
    const ids = (n.projectRefs ?? [])
      .map((r) => r.split(":")[1])
      .filter((id) => info[id]);
    if (ids.length === 0) {
      unfiled.push(n);
      continue;
    }
    for (const id of ids) {
      const pi = info[id];
      const g =
        byId.get(id) ??
        (byId.set(id, {
          key: id,
          label: pi.name,
          color: categoryColor(pi.category ?? pi.name),
          kind: pi.kind,
          notes: [],
        }),
        byId.get(id)!);
      g.notes.push(n);
    }
  }
  const groups = [...byId.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "area" ? -1 : 1;
    return b.notes.length - a.notes.length;
  });
  if (unfiled.length) {
    groups.push({ key: UNFILED, label: "Unfiled", color: null, kind: "", notes: unfiled });
  }
  return groups;
}

function FilterPill({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
        active
          ? "border-white/20 bg-white/6 text-ink"
          : "border-white/8 text-ink-dim hover:bg-white/4",
      )}
    >
      <span
        className="size-1.5 rounded-full"
        style={color ? { background: color } : { border: "1px solid rgba(255,255,255,0.25)" }}
      />
      <span className="max-w-[12rem] truncate">{label}</span>
      <span className="font-mono text-[10px] text-ink-faint">{count}</span>
    </button>
  );
}

function SectionHeader({ group }: { group: NoteGroup }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span
        className="size-2 rounded-full"
        style={group.color ? { background: group.color } : { border: "1px solid rgba(255,255,255,0.2)" }}
      />
      <h3 className="font-display text-sm font-semibold text-ink">{group.label}</h3>
      {group.kind === "area" && (
        <span className="rounded border border-white/8 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          area
        </span>
      )}
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {group.notes.length}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-white/8 to-transparent" />
    </div>
  );
}

export function NotesGrid({
  notes,
  projectInfo = {},
}: {
  notes: Note[];
  /** projectId → { name, category, kind }, for grouping + the card badge. */
  projectInfo?: Record<string, ProjInfo>;
}) {
  const [active, setActive] = useState<string | null>(null);
  const groups = useMemo(() => groupNotes(notes, projectInfo), [notes, projectInfo]);
  const shown = active ? groups.filter((g) => g.key === active) : groups;

  const badge = (n: Note): string | undefined => {
    const names = (n.projectRefs ?? [])
      .map((r) => projectInfo[r.split(":")[1]]?.name)
      .filter(Boolean) as string[];
    if (names.length === 0) return undefined;
    return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  };

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
        <>
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <FilterPill
              label="All"
              count={notes.length}
              color={null}
              active={active === null}
              onClick={() => setActive(null)}
            />
            {groups.map((g) => (
              <FilterPill
                key={g.key}
                label={g.label}
                count={g.notes.length}
                color={g.color}
                active={active === g.key}
                onClick={() => setActive(active === g.key ? null : g.key)}
              />
            ))}
          </div>
          <div className="flex flex-col gap-8">
            {shown.map((g) => (
              <section key={g.key}>
                <SectionHeader group={g} />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {g.notes.map((n, i) => (
                    <NoteCard key={n.id} note={n} index={i} projectName={badge(n)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
