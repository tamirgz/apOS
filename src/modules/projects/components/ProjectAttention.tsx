"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { act } from "@/core/ui/feedback";
import { doneAttention, dismissAttention } from "@/modules/today/actions";

interface Item {
  id: string;
  type: string;
  title: string;
  body: string | null;
}

/**
 * The project's open "Needs you" cards, made actionable. Resolving one (Done =
 * you handled it, Dismiss = not relevant) closes it and refreshes the page, so
 * the count and the card update immediately.
 */
export function ProjectAttention({ items }: { items: Item[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (items.length === 0) return null;

  const resolve = (fn: (id: string) => Promise<void>, id: string) =>
    start(async () => {
      await act(() => fn(id), { failed: "Couldn't resolve the card" });
      router.refresh();
    });

  return (
    <section aria-label="Needs you" className="flex flex-col gap-2.5">
      <h3 className="wk-sec-h !text-solar">
        Needs you <span className="tabular-nums">{items.length}</span>
      </h3>
      <AnimatePresence mode="popLayout">
        {items.map((a) => (
          <motion.div
            key={a.id}
            layout
            exit={{ opacity: 0, x: 12 }}
            className="wk-card group !flex-row !items-start !gap-3 !p-3.5"
          >
            <i className="mt-[6px] inline-block size-2 shrink-0 rounded-full bg-solar" aria-hidden />
            <div className="min-w-0 flex-1">
              <p dir="auto" className="text-[13.5px] leading-snug text-ink">{a.title}</p>
              {a.body && (
                <p dir="auto" className="mt-1 text-[12.5px] leading-snug text-ink-dim">{a.body}</p>
              )}
              <span className="mt-1.5 inline-block text-[11px] text-ink-faint">{a.type.replace(/_/g, " ")}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title="Done — I handled this"
                disabled={pending}
                onClick={() => resolve(doneAttention, a.id)}
                className="wk-btn primary !gap-1 !px-2 !py-0.5 text-[11.5px]"
              >
                <Check className="size-3" /> Done
              </button>
              <button
                type="button"
                title="Dismiss — not relevant"
                disabled={pending}
                onClick={() => resolve(dismissAttention, a.id)}
                aria-label="Dismiss"
                className="rounded-md p-1.5 text-ink-faint transition hover:bg-ink/6 hover:text-ink disabled:opacity-40"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  );
}
