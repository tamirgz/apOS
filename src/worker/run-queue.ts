/**
 * Agent-run admission queue — one machine, one GPU.
 *
 * `local-queue.ts` serializes individual MODEL CALLS (released between tool
 * turns so a tool's own embed can't deadlock). But nothing bounded how many
 * agent RUNS were in flight at once: every cron fired `executeRun` directly and
 * in parallel, so co-scheduled agents (e.g. Daily brief + Project pulse both at
 * 07:00, both on a 30B local model) all entered together and fought over the
 * single local slot. Each parked run kept its 10-min run-timeout clock ticking
 * while it waited, so a run that sat >10 min in the queue reached the model
 * already-aborted → an instant "Request was aborted" the moment it got the slot.
 * That's the morning wall of `timed_out` runs with 20-27 min wall times.
 *
 * This admits at most `AIOS_AGENT_RUN_CONCURRENCY` (default 1) runs into
 * execution at a time. A run acquires its slot BEFORE it claims the DB row, so
 * a waiting run stays `queued` (not `running`) — the orphan sweep leaves it
 * alone and its timeout clock hasn't started. Co-fires line up and run one after
 * another instead of thrashing the machine.
 *
 * Per-process, like local-queue: the worker is the single runner (advisory
 * lock), so an in-process semaphore is the whole story.
 */
const LIMIT = Math.max(
  1,
  Number(process.env.AIOS_AGENT_RUN_CONCURRENCY ?? 1),
);

let active = 0;
const waiters: Array<() => void> = [];

/** How many agent runs are executing right now (0 = machine idle of agents). */
export function activeRunCount(): number {
  return active;
}

function acquire(): Promise<void> {
  if (active < LIMIT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight to the next waiter (active kept)
  else active--;
}

/** Run `fn` while holding an agent-run admission slot. */
export async function withRunSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
