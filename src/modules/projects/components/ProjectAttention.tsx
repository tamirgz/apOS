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
    <section className="flex flex-col gap-2">
      <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-solar">
        needs you
      </h2>
      <AnimatePresence mode="popLayout">
        {items.map((a) => (
          <motion.div
            key={a.id}
            layout
            exit={{ opacity: 0, x: 12 }}
            className="group glass flex items-start gap-2.5 rounded-xl border-l-2 border-solar/50 p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{a.title}</p>
              {a.body && (
                <p className="mt-0.5 text-xs leading-snug text-ink-dim">{a.body}</p>
              )}
            </div>
            <span className="mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              {a.type}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title="Done — I handled this"
                disabled={pending}
                onClick={() => resolve(doneAttention, a.id)}
                className="rounded-md p-1.5 text-ink-dim transition hover:bg-plasma/15 hover:text-plasma disabled:opacity-40"
              >
                <Check className="size-3.5" />
              </button>
              <button
                type="button"
                title="Dismiss — not relevant"
                disabled={pending}
                onClick={() => resolve(dismissAttention, a.id)}
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
