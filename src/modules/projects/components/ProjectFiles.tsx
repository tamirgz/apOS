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
    <section aria-label="Files" className="glass flex flex-col gap-2.5 rounded-2xl p-5">
      <header className="flex items-center gap-2">
        <h3 className="wk-sec-h">
          <Paperclip className="size-3.5 text-ion" /> Files <span className="tabular-nums">{files.length}</span>
        </h3>
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
          "flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed py-4 text-[12.5px] transition",
          dragOver
            ? "border-ion/50 bg-ion/5 text-ion"
            : "border-ion/12 text-ink-faint hover:border-ion/24 hover:text-ink-dim",
        )}
      >
        <UploadCloud className="size-4" />
        {pending ? "Uploading…" : "Drop files here, or click to browse"}
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

      {files.length > 0 && (
        <div className="-mx-2 flex flex-col">
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
                  className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-ink/4"
                >
                  <FileText className="size-3.5 shrink-0 text-ink-faint" />
                  <a
                    href={`/api/projects/files/${f.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View / download"
                    className="min-w-0 flex-1 truncate text-[13px] text-ink-dim transition hover:text-ink"
                  >
                    {f.filename}
                  </a>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    {formatBytes(f.sizeBytes)}
                  </span>
                  <span
                    title={f.statusDetail ?? undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-[11px]",
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
                    aria-label={`Delete ${f.filename}`}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await act(() => deleteProjectFile(f.id, projectId), { failed: "Couldn't delete the file" });
                        router.refresh();
                      })
                    }
                    className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:bg-flare/10 hover:text-flare disabled:opacity-40"
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
