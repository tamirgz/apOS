/**
 * Route-level loading skeleton for every shell page. Module pages are async
 * server components doing several DB round-trips before anything paints —
 * without this boundary a navigation showed nothing at all until the whole
 * page resolved, which read as "nothing happened".
 */
export default function Loading() {
  return (
    <div className="flex animate-pulse flex-col gap-4">
      <div className="h-7 w-44 rounded-lg bg-white/4" />
      <div className="glass h-28 rounded-2xl" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="glass h-44 rounded-2xl" />
        <div className="glass h-44 rounded-2xl" />
      </div>
      <p className="px-1 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        loading…
      </p>
    </div>
  );
}
