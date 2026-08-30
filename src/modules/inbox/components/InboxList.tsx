"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Inbox,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { captureToInbox, deleteInboxItem, retryTriage } from "../actions";
import type { InboxItem, InboxStatus } from "../schema";

const STATUS_META: Record<
  InboxStatus,
  { label: string; color: string; pulse: boolean }
> = {
  new: { label: "queued", color: "var(--color-ink-faint)", pulse: true },
  triaging: { label: "routing…", color: "var(--color-solar)", pulse: true },
  triaged: { label: "auditing…", color: "var(--color-solar)", pulse: true },
  completed: { label: "completed", color: "var(--color-plasma)", pulse: false },
  failed: { label: "failed", color: "var(--color-flare)", pulse: false },
  error: { label: "failed", color: "var(--color-flare)", pulse: false },
};

/** Which display group a status falls into. */
type Group = "failed" | "flight" | "completed";
function groupOf(status: InboxStatus): Group {
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed") return "completed";
  return "flight"; // new · triaging · triaged
}

function CaptureBox() {
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = ref.current?.value.trim();
        if (!v || pending) return;
        startTransition(async () => {
          await captureToInbox(v);
          if (ref.current) ref.current.value = "";
        });
      }}
      className="glass mb-4 flex items-start gap-3 rounded-2xl p-3 focus-within:glass-edge"
    >
      <Inbox className="mt-1 size-5 shrink-0 text-solar" />
      <textarea
        ref={ref}
        rows={1}
        autoFocus
        onKeyDown={(e) => {
          // Dump-and-move-on: Enter submits, Shift+Enter makes a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Dump anything — a to-do, an idea, a link, 'call dan tuesday 3pm'… AI files it for you."
        className="min-h-10 flex-1 resize-y bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint"
        disabled={pending}
      />
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-2 rounded-lg bg-solar/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-solar transition hover:bg-solar/25 disabled:opacity-40"
      >
        <Zap className="size-3.5" />
        {pending ? "…" : "capture"}
      </button>
    </form>
  );
}

function ItemCard({
  item,
  onRetry,
  onDelete,
}: {
  item: InboxItem;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const status = STATUS_META[item.status];
  const failed = groupOf(item.status) === "failed";
  const verified = item.triage?.verified;

  return (
    <motion.div
      key={item.id}
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 34 }}
      className="group glass rounded-xl p-4"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn("mt-1.5 dot shrink-0", status.pulse && "animate-pulse-soft")}
          style={{ color: status.color }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-ink">
            {item.input.length > 160 ? item.input.slice(0, 160) + "…" : item.input}
          </p>
          {item.triage?.summary && (
            <p className="mt-1 text-xs text-plasma/80">→ {item.triage.summary}</p>
          )}
          {item.triage?.route && (
            <Link
              href={item.triage.route.href}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-plasma/30 bg-plasma/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20"
            >
              open in {item.triage.route.label}
              <ArrowUpRight className="size-3" />
            </Link>
          )}
          {/* The audit's reasoning — always shown when it failed, so the user
              knows what to fix; a subtle check when it passed. */}
          {verified && (
            <p
              className={cn(
                "mt-1.5 text-[11px] leading-snug",
                verified.ok ? "text-ink-faint" : "text-flare",
              )}
            >
              {verified.ok ? "✓ audited" : "audit: "}
              {verified.note ? ` ${verified.note}` : ""}
            </p>
          )}
          {item.error && (
            <p className="mt-1 font-mono text-[10px] text-flare">{item.error}</p>
          )}
        </div>
        <span
          className="shrink-0 font-mono text-[9px] uppercase tracking-widest"
          style={{ color: status.color }}
        >
          {status.label}
        </span>
      </div>
      <div className="mt-2 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
        {failed && (
          <button
            type="button"
            title="Re-run triage"
            onClick={onRetry}
            className="rounded-md p-1.5 text-ink-faint transition hover:text-solar"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Delete"
          onClick={onDelete}
          className="rounded-md p-1.5 text-ink-faint transition hover:text-flare"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

function GroupHeader({
  label,
  count,
  color,
  collapsible = false,
  open = true,
  onToggle,
}: {
  label: string;
  count: number;
  color: string;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const inner = (
    <>
      {collapsible && (
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
      )}
      <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color }}>
        {label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-ink-faint/70">{count}</span>
    </>
  );
  return collapsible ? (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 px-1 py-1 text-ink-faint transition hover:text-ink-dim"
    >
      {inner}
    </button>
  ) : (
    <div className="flex items-center gap-1.5 px-1 py-1">{inner}</div>
  );
}

export function InboxList({ items }: { items: InboxItem[] }) {
  const [, startTransition] = useTransition();
  useLiveEvents(["inbox_changed"]);
  const [showCompleted, setShowCompleted] = useState(false); // collapsed by default

  const failed = items.filter((i) => groupOf(i.status) === "failed");
  const flight = items.filter((i) => groupOf(i.status) === "flight");
  const completed = items.filter((i) => groupOf(i.status) === "completed");

  const card = (item: InboxItem) => (
    <ItemCard
      key={item.id}
      item={item}
      onRetry={() => startTransition(async () => void (await retryTriage(item.id)))}
      onDelete={() => startTransition(async () => void (await deleteInboxItem(item.id)))}
    />
  );

  return (
    <div className="max-w-3xl">
      <CaptureBox />
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-14 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          inbox zero — nice
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {failed.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <GroupHeader label="Needs attention" count={failed.length} color="var(--color-flare)" />
              <AnimatePresence mode="popLayout">{failed.map(card)}</AnimatePresence>
            </section>
          )}
          {flight.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <GroupHeader label="In flight" count={flight.length} color="var(--color-solar)" />
              <AnimatePresence mode="popLayout">{flight.map(card)}</AnimatePresence>
            </section>
          )}
          {completed.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <GroupHeader
                label="Completed"
                count={completed.length}
                color="var(--color-plasma)"
                collapsible
                open={showCompleted}
                onToggle={() => setShowCompleted((o) => !o)}
              />
              {showCompleted && (
                <AnimatePresence mode="popLayout">{completed.map(card)}</AnimatePresence>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
