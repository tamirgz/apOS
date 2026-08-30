"use client";

/**
 * Route-level error boundary for every shell page. A throwing page used to
 * take the whole app down to Next's default screen; this keeps the shell
 * (sidebar, ⌘K) alive and offers a retry.
 */
export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
