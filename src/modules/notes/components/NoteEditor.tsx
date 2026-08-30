"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { ArrowLeft, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { Markdown } from "@/core/ui/Markdown";
import { deleteNote, setNoteProjects, updateNote } from "../actions";
import type { Note } from "../schema";
import { ProjectMultiPicker } from "@/modules/projects/components/ProjectMultiPicker";
import type { ProjectOption } from "@/modules/projects/queries";

type SaveStatus = "saved" | "saving" | "unsaved";

const STATUS_STYLE: Record<SaveStatus, string> = {
  saved: "text-plasma",
  saving: "text-solar",
  unsaved: "text-ink-faint",
};

export function NoteEditor({
  note,
  projects = [],
}: {
  note: Note;
  projects?: ProjectOption[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [projectRefs, setProjectRefs] = useState<string[]>(note.projectRefs ?? []);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const queueSave = (nextTitle: string, nextBody: string) => {
    setStatus("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setStatus("saving");
      await updateNote(note.id, {
        title: nextTitle.trim() || "Untitled note",
        body: nextBody,
      });
      setStatus("saved");
      setSavedAt(
        new Date().toLocaleTimeString(undefined, { hour12: false }),
      );
    }, 800);
  };

  const onDelete = async () => {
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 2500);
      return;
    }
    setDeleting(true);
    await deleteNote(note.id);
    router.push("/m/notes");
  };

  return (
    <div className="flex flex-col gap-4">
      <style>{`
        .cm-notes .cm-editor { background: transparent; outline: none; }
        .cm-notes .cm-gutters { background: transparent; border: none; }
        .cm-notes .cm-activeLine { background: transparent; }
        .cm-notes .cm-scroller { font-family: var(--font-mono); font-size: 13px; line-height: 1.7; }
      `}</style>

      <header className="flex items-center gap-3">
        <Link
          href="/m/notes"
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          notes
        </Link>
        <ProjectMultiPicker
          options={projects}
          value={projectRefs}
          onChange={async (next) => {
            setProjectRefs(next);
            await setNoteProjects(note.id, next);
          }}
        />
        <span
          className={cn(
            "ml-auto font-mono text-[10px] uppercase tracking-widest",
            STATUS_STYLE[status],
          )}
        >
          {status === "saving"
            ? "saving…"
            : status === "unsaved"
              ? "unsaved"
              : savedAt
                ? `saved · ${savedAt}`
                : "saved"}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          title="Delete note"
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-40",
            armed
              ? "border-flare/40 bg-flare/10 text-flare"
              : "border-white/8 text-ink-faint hover:bg-flare/10 hover:text-flare",
          )}
        >
          <Trash2 className="size-3.5" />
          {deleting ? "…" : armed ? "sure?" : "delete"}
        </button>
      </header>

      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          queueSave(e.target.value, body);
        }}
        placeholder="Untitled note"
        className="w-full bg-transparent font-display text-3xl font-semibold text-ink outline-none placeholder:text-ink-faint"
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="glass min-h-[24rem] rounded-xl p-3">
          <p className="mb-2 px-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            markdown
          </p>
          <CodeMirror
            value={body}
            theme="dark"
            extensions={[markdown()]}
            onChange={(value) => {
              setBody(value);
              queueSave(title, value);
            }}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
            placeholder="Write markdown…"
            className="cm-notes"
          />
        </section>
        <section className="glass min-h-[24rem] rounded-xl p-5">
          <p className="mb-3 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            preview
          </p>
          {body.trim() ? (
            <Markdown size="note">{body}</Markdown>
          ) : (
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              nothing to preview
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
