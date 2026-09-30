import Link from "next/link";
import { listNeedsYou, splitHygiene, todaySummary } from "../queries";
import { NeedsYouList } from "./NeedsYouList";

// Tier-1 dashboard hero: not just the count — the actual items that need the
// user, actionable in place (done/dismiss) for attention-kind items.
const MAX_ITEMS = 6;

export async function NeedsYouWidget() {
  const [raw, summary] = await Promise.all([listNeedsYou(), todaySummary()]);

  // Collapse exact duplicates (same kind+source+title) — agents occasionally
  // raise the same attention card twice without a dedupe key, which the old
  // count-only widget hid. Keep the first (list is pre-sorted by urgency).
  // Project-hygiene nags fold into one digest row (see splitHygiene).
  const { focus, hygiene } = splitHygiene(raw);
  const seen = new Set<string>();
  const items = focus.filter((it) => {
    const key = `${it.kind}:${it.source}:${it.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="flex h-full flex-col">
      <Link href="/m/today/queue" className="mb-2 flex items-baseline gap-2.5">
        <span className="font-display text-4xl font-semibold leading-none text-solar text-glow">
          {items.length}
        </span>
        <span className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          need{items.length === 1 ? "s" : ""} you
        </span>
        <span className="ml-auto text-right font-mono text-[9px] uppercase leading-tight tracking-widest text-ink-faint">
          {summary.events} event{summary.events === 1 ? "" : "s"} · {summary.dueTasks} due today
          <br />
          across tasks, inbox &amp; agents
        </span>
      </Link>
      <div className="min-h-0 flex-1">
        <NeedsYouList
          items={items.slice(0, hygiene.length ? MAX_ITEMS - 1 : MAX_ITEMS)}
          hygieneCount={hygiene.length}
        />
      </div>
    </div>
  );
}
