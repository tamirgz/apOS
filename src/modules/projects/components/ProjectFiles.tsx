"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { FileText, Paperclip, Trash2, UploadCloud } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act, failed } from "@/core/ui/feedback";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { deleteProjectFile, uploadProjectFiles } from "../files-actions";
import type { ProjectFileStatus } from "../schema";

/** Mirrors the server's per-file limit (files-actions.ts). */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface ProjectFileRow {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  status: ProjectFileStatus;
  statusDetail: string | null;
  createdAt: Date;
}

const STATUS_META: Record<
  ProjectFileStatus,
  { label: string; color: string; pulse: boolean }
> = {
  processing: { label: "processing…", color: "var(--color-solar)", pulse: true },
  ready: { label: "indexed", color: "var(--color-plasma)", pulse: false },
  error: { label: "error", color: "var(--color-flare)", pulse: false },
  unsupported: { label: "not searchable", color: "var(--color-ink-faint)", pulse: false },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Files attached to this project. Each upload is queued for text extraction
 * in the worker (status: processing → ready/unsupported/error), then the
 * embedding sweep picks up "ready" files so they're searchable and answerable
 * via Ask/agents — the same pipeline the Knowledge module uses.
 */
export function ProjectFiles({
  projectId,
  files,
}: {
  projectId: string;
  files: ProjectFileRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Status transitions (processing -> ready) happen in the worker — refresh
  // this page live instead of leaving a stale "processing…" forever.
  useLiveEvents(["project_files_changed"]);

  const upload = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    // Oversized files are refused here: sent along, they'd exceed the server
    // action's body limit and fail the whole batch with a redacted error.
    const fd = new FormData();
    const tooBig: string[] = [];
    for (const f of fileList) {
      if (f.size > MAX_UPLOAD_BYTES) tooBig.push(f.name);
      else fd.append("files", f);
    }
    if (tooBig.length) failed(`Too large to upload (20 MB max)`, tooBig.join(", "));
    if (!fd.has("files")) return;
    startTransition(async () => {
      const r = await act(() => uploadProjectFiles(projectId, fd), { failed: "Couldn't upload" });
      const refused = r.ok ? r.value.filter((f) => !f.ok) : [];
      if (refused.length) failed("Couldn't upload", refused.map((f) => `${f.filename}: ${f.error}`).join("; "));
      router.refresh();
    });
  };

  return (
    <section className="mt-6">
      <header className="mb-3 flex items-center gap-2 px-1">
        <Paperclip className="size-3.5 text-ion" />
        <h2 className="font-display text-sm font-medium uppercase tracking-[0.2em] text-ink-dim">
          Files
        </h2>
        <span className="font-mono text-xs tabular-nums text-ink-faint">
          {files.length}
        </span>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          upload(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "mb-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed py-6 font-mono text-[11px] uppercase tracking-widest transition",
          dragOver
            ? "border-ion/50 bg-ion/5 text-ion"
            : "border-white/8 text-ink-faint hover:border-white/16 hover:text-ink-dim",
        )}
      >
        <UploadCloud className="size-4" />
        {pending ? "uploading…" : "drop files here, or click to browse"}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          no files attached yet
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <AnimatePresence mode="popLayout">
            {files.map((f) => {
              const meta = STATUS_META[f.status];
              return (
                <motion.div
                  key={f.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="group glass flex items-center gap-3 rounded-xl px-3.5 py-2.5"
                >
                  <FileText className="size-3.5 shrink-0 text-ink-faint" />
                  <a
                    href={`/api/projects/files/${f.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View / download"
                    className="min-w-0 flex-1 truncate text-sm text-ink-dim transition hover:text-ink"
                  >
                    {f.filename}
                  </a>
                  <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                    {formatBytes(f.sizeBytes)}
                  </span>
                  <span
                    title={f.statusDetail ?? undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-widest",
                      meta.pulse && "animate-pulse-soft",
                    )}
                    style={{ color: meta.color }}
                  >
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: meta.color }}
                    />
                    {meta.label}
                  </span>
                  <button
                    type="button"
                    title="Delete"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await deleteProjectFile(f.id, projectId);
                        router.refresh();
                      })
                    }
                    className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:bg-flare/10 hover:text-flare disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
