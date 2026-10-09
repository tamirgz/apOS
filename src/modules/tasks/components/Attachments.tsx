"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileArchive, FileCode2, FileImage, FileText, Paperclip, Trash2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { errorText, failed } from "@/core/ui/feedback";
import { timeAgo } from "@/core/ui/time";
import type { TaskAttachment } from "../schema";

const url = (a: Pick<TaskAttachment, "id">) => `/api/work/attachments/${a.id}`;
const isImage = (a: TaskAttachment) => /^image\/(png|jpeg|webp)$/.test(a.contentType);

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function TypeIcon({ a }: { a: TaskAttachment }) {
  const cls = "size-4 shrink-0 text-ink-faint";
  if (a.contentType.startsWith("image/")) return <FileImage className={cls} />;
  if (a.contentType === "application/zip") return <FileArchive className={cls} />;
  if (/html|json/.test(a.contentType)) return <FileCode2 className={cls} />;
  return <FileText className={cls} />;
}

/** Full-size image over the page; Esc, the ✕ or a click outside closes it. */
export function Lightbox({ image, onClose }: { image: TaskAttachment | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (image && !d.open) d.showModal();
    if (!image && d.open) d.close();
  }, [image]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label={image?.name ?? "Image"}
      className="m-auto max-h-[92vh] max-w-[92vw] overflow-visible bg-transparent p-0 backdrop:bg-black/75 backdrop:backdrop-blur-sm"
    >
      {image && (
        <figure className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- same-origin file route, nothing for the optimizer to do */}
          <img src={url(image)} alt={image.caption ?? image.name} className="max-h-[84vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
          <figcaption className="flex items-center gap-3 font-mono text-[11px] text-white/80">
            <span className="truncate">
              {image.name}
              {image.version > 1 && ` · v${image.version}`}
              {image.caption && ` — ${image.caption}`}
            </span>
            <a href={`${url(image)}?download=1`} className="ml-auto inline-flex items-center gap-1 hover:text-white">
              <Download className="size-3.5" /> download
            </a>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-white/10 hover:text-white">
              <X className="size-4" />
            </button>
          </figcaption>
        </figure>
      )}
    </dialog>
  );
}

/**
 * A set of attachments: images as thumbnails (open the lightbox), everything
 * else as a row with kind + size chips and a download link that keeps the
 * original name. `onDelete` adds a two-step remove (soft delete).
 */
export function AttachmentList({
  items,
  onOpenImage,
  onDelete,
  compact,
}: {
  items: TaskAttachment[];
  onOpenImage: (a: TaskAttachment) => void;
  onDelete?: (a: TaskAttachment) => void;
  compact?: boolean;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  if (!items.length) return null;
  const images = items.filter(isImage);
  const files = items.filter((a) => !isImage(a));
  const del = (a: TaskAttachment) =>
    onDelete && (
      <button
        type="button"
        onClick={() => (armed === a.id ? (setArmed(null), onDelete(a)) : setArmed(a.id))}
        onBlur={() => setArmed((x) => (x === a.id ? null : x))}
        aria-label={armed === a.id ? `Confirm removing ${a.name}` : `Remove ${a.name}`}
        className={cn(
          "shrink-0 rounded px-1 py-0.5 font-mono text-[10px] transition",
          armed === a.id ? "bg-flare/15 text-flare" : "text-ink-faint opacity-0 hover:text-flare group-hover:opacity-100 focus:opacity-100",
        )}
      >
        {armed === a.id ? "remove?" : <Trash2 className="size-3" />}
      </button>
    );
  return (
    <div className={cn("flex flex-col gap-2", compact && "mt-1.5")}>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <figure key={a.id} className="group relative">
              <button
                type="button"
                onClick={() => onOpenImage(a)}
                title={`${a.name}${a.caption ? ` — ${a.caption}` : ""} · ${fileSize(a.sizeBytes)}`}
                className={cn(
                  "block overflow-hidden rounded-lg border border-ink/10 bg-ink/4 transition hover:border-ion/50 focus-visible:border-ion",
                  compact ? "size-20" : "size-24",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- see Lightbox */}
                <img src={url(a)} alt={a.caption ?? a.name} loading="lazy" className="size-full object-cover" />
              </button>
              <figcaption className="mt-0.5 flex max-w-24 items-center gap-1 font-mono text-[10px] text-ink-faint">
                <span className="truncate">{a.name}</span>
                {a.version > 1 && <span className="shrink-0">v{a.version}</span>}
                {del(a)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.id} className="group flex items-center gap-2 text-[12.5px] text-ink-dim">
          <TypeIcon a={a} />
          <a
            href={`${url(a)}${/html|svg|zip/.test(a.contentType) ? "?download=1" : ""}`}
            target="_blank"
            rel="noopener"
            className="min-w-0 truncate transition hover:text-ion"
            title={a.caption ?? `Open ${a.name}`}
          >
            {a.name}
          </a>
          {a.version > 1 && <span className="shrink-0 font-mono text-[10px] text-ink-faint">v{a.version}</span>}
          <span className="shrink-0 rounded bg-ink/6 px-1.5 py-px font-mono text-[10px] text-ink-faint">{a.kind}</span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{fileSize(a.sizeBytes)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {!compact && <time className="font-mono text-[10px] text-ink-faint">{timeAgo(a.createdAt)}</time>}
            <a href={`${url(a)}?download=1`} aria-label={`Download ${a.name}`} className="rounded p-0.5 text-ink-faint transition hover:text-ink">
              <Download className="size-3.5" />
            </a>
            {del(a)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** "attach" control: pick files, upload each, then refresh the item. */
export function AttachButton({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.set("taskId", taskId);
        form.set("file", f);
        form.set("kind", f.type.startsWith("image/") ? "screenshot" : "other");
        const res = await fetch("/api/work/attachments", { method: "POST", body: form });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          failed(`Couldn't attach ${f.name}`, j?.error ?? `HTTP ${res.status}`);
        }
      }
    } catch (e) {
      failed("Couldn't attach the file", errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      onDone();
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".png,.jpg,.jpeg,.webp,.svg,.pdf,.txt,.md,.log,.json,.csv,.html,.zip"
        onChange={(e) => upload(e.target.files)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-widest text-ink-faint transition hover:text-ink disabled:opacity-50"
      >
        <Paperclip className="size-3" /> {busy ? "attaching…" : "attach"}
      </button>
    </>
  );
}
