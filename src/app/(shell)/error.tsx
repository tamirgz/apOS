"use client";

import { useEffect, useState } from "react";

/**
 * Route-level error boundary for every shell page. A throwing page used to take
 * the whole app down to Next's default screen; this keeps the shell (sidebar,
 * ⌘K) alive.
 *
 * Most faults here are TRANSIENT: a page render needs a fresh DB connection and
 * the hosted-DB hostname intermittently fails to resolve (getaddrinfo ENOTFOUND
 * on the Supabase pooler) or a connection blips. A retry a moment later succeeds
 * — warm connections skip DNS entirely. So instead of showing the alarming
 * "page hit a fault" and making the user click retry, we AUTO-retry a transient
 * error a couple of times within a short window; only a persistent or clearly
 * non-transient error falls through to the manual fault screen.
 */

const TRANSIENT =
  /Failed query|ENOTFOUND|getaddrinfo|ECONN|ETIMEDOUT|EAI_AGAIN|Connection|terminating|timeout|fetch failed|socket hang up/i;

const KEY = "aios_err_retry";
const WINDOW_MS = 5000; // auto-retry budget resets after a quiet gap
const MAX_AUTO = 2;

export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const transient = TRANSIENT.test(error.message || "");
  // Decide ONCE, at mount, whether to auto-retry — reading the per-window budget
  // so a genuinely broken page can't loop. (Lazy init: no setState-in-effect.)
  const [autoRetrying] = useState(() => {
    if (!transient) return false;
    try {
      const raw = sessionStorage.getItem(KEY);
      let count = 0;
      if (raw) {
        const o = JSON.parse(raw) as { count: number; at: number };
        if (Date.now() - o.at < WINDOW_MS) count = o.count;
      }
      return count < MAX_AUTO;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!autoRetrying) return;
    // Charge this attempt against the window budget, then retry shortly.
    try {
      const raw = sessionStorage.getItem(KEY);
      let count = 0;
      if (raw) {
        const o = JSON.parse(raw) as { count: number; at: number };
        if (Date.now() - o.at < WINDOW_MS) count = o.count;
      }
      sessionStorage.setItem(KEY, JSON.stringify({ count: count + 1, at: Date.now() }));
    } catch {
      /* sessionStorage may be unavailable */
    }
    const t = setTimeout(() => reset(), 500);
    return () => clearTimeout(t);
  }, [autoRetrying, reset]);

  if (autoRetrying) {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-2xl px-8 py-20 text-center">
        <p className="animate-pulse-soft font-mono text-[11px] uppercase tracking-[0.35em] text-ink-faint">
          reconnecting…
        </p>
      </div>
    );
  }

  return (
    <div className="glass flex flex-col items-center gap-3 rounded-2xl px-8 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
        signal error
      </p>
      <h2 className="font-display text-2xl font-semibold text-ink">
        This page hit a fault
      </h2>
      <p className="max-w-md font-mono text-xs leading-relaxed text-ink-dim">
        {error.message?.slice(0, 300) || "unknown error"}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
      >
        retry
      </button>
    </div>
  );
}
