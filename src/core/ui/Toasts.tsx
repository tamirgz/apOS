"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, X } from "lucide-react";

export interface ToastInput {
  title: string;
  body?: string;
  level?: "error" | "info";
}

type Toast = ToastInput & { id: number };

// Module-level emitter so any client code can `toast({...})` without context
// plumbing; the single <Toasts/> in the shell renders them.
let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

export function toast(input: ToastInput) {
  const t: Toast = { level: "error", ...input, id: nextId++ };
  for (const l of listeners) l(t);
}

const TOAST_MS = 6000;

/**
 * Global action-failure surface. Most mutations in the app are fire-and-forget
 * server actions inside startTransition — when one rejected, the UI simply
 * didn't change and the error vanished into the console. An async transition
 * callback's rejection surfaces as `unhandledrejection`, so ONE window
 * listener here gives every mutation in the app visible failure feedback
 * without touching each component. Explicit `toast()` calls work too.
 */
export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const push = (t: Toast) => {
      setItems((prev) => {
        // Collapse rapid duplicates (a retry loop, a double click).
        if (prev.some((p) => p.title === t.title && p.body === t.body)) return prev;
        return [...prev.slice(-3), t];
      });
      setTimeout(() => {
        setItems((prev) => prev.filter((p) => p.id !== t.id));
      }, TOAST_MS);
    };
    listeners.add(push);

    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      // Only real errors — ignore cancellations and non-Error noise.
      if (!(r instanceof Error)) return;
      if (r.name === "AbortError") return;
      const msg = r.message.replace(/^Error:\s*/, "").slice(0, 200);
      if (!msg) return;
      push({
        id: nextId++,
        level: "error",
        title: "Action failed",
        body: msg,
      });
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      listeners.delete(push);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className={
              t.level === "info"
                ? "glass glass-edge pointer-events-auto rounded-xl border border-ion/25 p-3"
                : "glass glass-edge pointer-events-auto rounded-xl border border-flare/30 p-3"
            }
          >
            <div className="flex items-start gap-2.5">
              <CircleAlert
                className={
                  t.level === "info"
                    ? "mt-0.5 size-4 shrink-0 text-ion"
                    : "mt-0.5 size-4 shrink-0 text-flare"
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{t.title}</p>
                {t.body && (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-dim">
                    {t.body}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((p) => p.id !== t.id))}
                className="rounded-md p-1 text-ink-faint transition hover:text-ink"
                title="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
