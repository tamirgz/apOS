"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Clock,
  Eye,
  FolderKanban,
  ShieldCheck,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { decideApproval } from "@/modules/agents/actions";
import { doneAttention, dismissAttention, snoozeAttention } from "../actions";
import type { NeedsYouItem } from "../queries";
import type { AttentionType } from "../schema";

const TYPE_META: Record<
  AttentionType,
  { icon: typeof Bell; color: string; label: string }
> = {
  notify: { icon: Bell, color: "var(--color-ink-dim)", label: "fyi" },
  question: { icon: CircleHelp, color: "var(--color-gold)", label: "decide" },
  review: { icon: Eye, color: "var(--color-ion)", label: "review" },
  approve: { icon: ShieldCheck, color: "var(--color-flare)", label: "approve" },
  do: { icon: Sparkles, color: "var(--color-solar)", label: "do" },
};

function Row({ item }: { item: NeedsYouItem }) {
  const [pending, start] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const meta = TYPE_META[item.type];
  const Icon = meta.icon;
  // Attention items resolve inline (done/snooze/dismiss); approvals resolve
  // inline too (approve/reject → the worker runs or drops the parked action).
  // Workbench tasks are acted on where they live (linked via href).
  const inline = item.kind === "attention";
  const isApproval = item.kind === "approval";
  // A long body (the weekly review, a synthesis) expands in place — clamped to
  // two lines it was permanently unreadable.
  const expandable = (item.body?.length ?? 0) > 160;

  const body = (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color: meta.color }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-ink">{item.title}</p>
        {item.body && (
          <p
            className={cn(
              "mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-dim",
              !expanded && "line-clamp-2",
            )}
          >
            {item.body}
          </p>
        )}
      </div>
    </div>
  );

  // Rendered OUTSIDE the card's own link (chips are links themselves).
  const metaRow = (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
      <span style={{ color: meta.color }}>{meta.label}</span>
      <span>·</span>
      <span>{item.source}</span>
      {item.project && (
        <Link
          href={`/m/projects/${item.project.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 normal-case tracking-normal text-ink-dim transition hover:border-solar/40 hover:text-solar"
        >
          <FolderKanban className="size-2.5" />
          {item.project.name}
        </Link>
      )}
      {item.person && (
        <Link
          href={`/m/people/${item.person.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 normal-case tracking-normal text-ink-dim transition hover:border-ion/40 hover:text-ion"
        >
          <User className="size-2.5" />
          {item.person.name}
        </Link>
      )}
      {expandable && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-ink-faint transition hover:text-ink"
        >
          <ChevronDown
            className={cn("size-3 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "less" : "more"}
        </button>
      )}
    </div>
  );

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      className="group glass rounded-xl p-3 transition hover:glass-edge"
    >
      <div className="flex items-start gap-2">
        {item.href && !isApproval ? (
          <Link href={item.href} className="min-w-0 flex-1">
            {body}
          </Link>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}

        {isApproval && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              title="Approve — runs the action"
              disabled={pending}
              onClick={() =>
                start(async () => void (await decideApproval(item.id, true)))
              }
              className="inline-flex items-center gap-1 rounded-md border border-plasma/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/10 disabled:opacity-40"
            >
              <Check className="size-3" />
              approve
            </button>
            <button
              type="button"
              title="Reject — drops the action"
              disabled={pending}
              onClick={() =>
                start(async () => void (await decideApproval(item.id, false)))
              }
              className="rounded-md p-1.5 text-ink-faint transition hover:text-flare disabled:opacity-40"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {inline && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              title="Done"
              disabled={pending}
              onClick={() => start(async () => void (await doneAttention(item.id)))}
              className="rounded-md p-1.5 text-ink-faint transition hover:text-plasma"
            >
              <Check className="size-3.5" />
            </button>
            <button
              type="button"
              title="Snooze 3h"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await snoozeAttention(item.id, new Date(Date.now() + 3 * 3600_000));
                })
              }
              className="rounded-md p-1.5 text-ink-faint transition hover:text-ion"
            >
              <Clock className="size-3.5" />
            </button>
            <button
              type="button"
              title="Dismiss"
              disabled={pending}
              onClick={() =>
                start(async () => void (await dismissAttention(item.id)))
              }
              className="rounded-md p-1.5 text-ink-faint transition hover:text-flare"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {metaRow}
    </motion.div>
  );
}

/**
 * The "Needs you" queue — the unified attention surface. One list of typed,
 * urgency-sorted cards drawn from attention items + pending approvals +
 * Workbench needs_input. Refreshes live as agents raise or the user resolves.
 */
export function NeedsYouQueue({ items }: { items: NeedsYouItem[] }) {
  useLiveEvents(["attention_changed", "approvals_changed", "workbench_changed"]);

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 px-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          needs you
        </p>
        {items.length > 0 && (
          <span className="font-mono text-[10px] text-solar">{items.length}</span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="glass rounded-xl p-6 text-center">
          <Check className="mx-auto size-5 text-plasma" />
          <p className="mt-2 text-sm text-ink-dim">Nothing needs you right now.</p>
          <p className="mt-1 text-xs text-ink-faint">
            Agents surface what slips here — you don&apos;t have to go looking.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <Row key={`${it.kind}:${it.id}`} item={it} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
