"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, X } from "lucide-react";
import { errorText, failed, useFeedback } from "./feedback";

const TOAST_MS = 8000;

/**
 * Corner toasts — errors only. Successes go to the top bar's status slot (see
 * StatusSlot), so this corner stays quiet unless something needs attention.
 *
 * Actions run through `act()` (./feedback) report their own failures. The
 * `unhandledrejection` listener is the fallback for any promise nobody awaited
 * or caught — a bare `void action()` or an async event handler.
 */
export function Toasts() {
  const { entries } = useFeedback();
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const errors = entries.filter((e) => e.level === "error" && !hidden.has(e.id)).slice(0, 4);
  const key = errors.map((e) => e.id).join(",");

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      // Only real errors — ignore cancellations and non-Error noise.
      if (!(r instanceof Error) || r.name === "AbortError") return;
      const msg = errorText(r);
      if (msg) failed("Action failed", msg);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  // Each visible error hides itself TOAST_MS after it arrived.
  useEffect(() => {
    const hide = (id: number) => setHidden((h) => new Set(h).add(id));
    const timers = errors.map((e) => setTimeout(() => hide(e.id), Math.max(0, e.at + TOAST_MS - Date.now())));
    return () => timers.forEach(clearTimeout);
    // `key` captures the visible set; `errors` itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence>
        {errors.map((t) => (
          <motion.div
            key={t.id}
            layout
            role="alert"
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="glass glass-edge pointer-events-auto rounded-xl border border-flare/30 p-3"
          >
            <div className="flex items-start gap-2.5">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-flare" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{t.title}</p>
                {t.body && (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-dim">{t.body}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setHidden((h) => new Set(h).add(t.id))}
                className="rounded-md p-1 text-ink-faint transition hover:text-ink"
                title="Dismiss"
                aria-label="Dismiss"
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
