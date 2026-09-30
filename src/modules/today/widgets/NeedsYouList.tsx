"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { doneAttention, dismissAttention } from "../actions";
import type { NeedsYouItem } from "../queries";

// Source label per item kind, kept terse for the card.
const KIND_LABEL: Record<NeedsYouItem["kind"], string> = {
  attention: "flag",
  approval: "approve",
  workbench: "review",
};

const KIND_DOT: Record<NeedsYouItem["kind"], string> = {
  attention: "var(--color-solar)",
  approval: "var(--color-flare)",
  workbench: "var(--color-ion)",
};

export function NeedsYouList({
  items,
  hygieneCount = 0,
}: {
  items: NeedsYouItem[];
  /** Folded project-hygiene nags, shown as one digest row linking to the queue. */
  hygieneCount?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Live-refresh when attention or approvals state changes elsewhere.
  useLiveEvents(["attention_changed", "approvals_changed"]);

  if (items.length === 0 && hygieneCount === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        you&apos;re clear — nothing needs you
      </p>
    );
  }

  const resolve = (fn: (id: string) => Promise<unknown>, id: string) =>
    start(async () => {
      await fn(id);
      router.refresh();
    });

  return (
    <ul className="flex flex-col">
      {items.map((it) => {
        const row = (
          <>
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full"
              style={{ background: KIND_DOT[it.kind] }}
            />
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink"
            >
              {it.title}
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              {KIND_LABEL[it.kind]}
            </span>
          </>
        );
        return (
          <li
            key={`${it.kind}:${it.id}`}
            className="group flex items-center gap-2.5 border-t border-white/5 py-2 first:border-t-0"
          >
            {it.href ? (
              <Link href={it.href} className="flex min-w-0 flex-1 items-center gap-2.5">
                {row}
              </Link>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2.5">{row}</div>
            )}
            {/* Attention items resolve in place; others link to where they're handled. */}
            {it.kind === "attention" && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={pending}
                  title="Mark done"
                  onClick={() => resolve(doneAttention, it.id)}
                  className="rounded-md border border-plasma/25 bg-plasma/10 p-1 text-plasma transition hover:bg-plasma/20 disabled:opacity-40"
                >
                  <Check className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={pending}
                  title="Dismiss"
                  onClick={() => resolve(dismissAttention, it.id)}
                  className={cn(
                    "rounded-md border border-white/10 p-1 text-ink-faint transition hover:bg-white/5 hover:text-ink-dim disabled:opacity-40",
                  )}
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
          </li>
        );
      })}
      {hygieneCount > 0 && (
        <li className="group flex items-center gap-2.5 border-t border-white/5 py-2 first:border-t-0">
          <Link
            href="/m/today/queue#hygiene"
            className="flex min-w-0 flex-1 items-center gap-2.5"
          >
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full"
              style={{ background: "var(--color-gold)" }}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
              {hygieneCount} project check-in{hygieneCount === 1 ? "" : "s"}
              <span className="text-ink-faint"> — setup, archive &amp; health</span>
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              digest
            </span>
          </Link>
        </li>
      )}
    </ul>
  );
}
