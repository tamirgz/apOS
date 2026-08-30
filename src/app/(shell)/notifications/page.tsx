import Link from "next/link";
import { desc, ilike, or, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { notifications } from "@/core/db/schema/notifications";
import { cn } from "@/core/ui/cn";
import { MarkAllReadButton } from "./MarkAllReadButton";

// Live DB data — never prerender.
export const dynamic = "force-dynamic";

const LEVEL_COLOR = {
  info: "var(--color-ion)",
  success: "var(--color-plasma)",
  warn: "var(--color-solar)",
} as const;

/** Filter pills — each maps to a source-prefix predicate. */
const FILTERS = [
  { id: "all", label: "all" },
  { id: "briefs", label: "briefs" }, // Slack-ingested routine reports (#my-today, #tldr)
  { id: "agents", label: "agents" },
  { id: "flows", label: "flows" },
  { id: "system", label: "system" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

function filterWhere(f: FilterId) {
  switch (f) {
    case "briefs":
      return ilike(notifications.source, "slack:%");
    case "agents":
      return or(
        ilike(notifications.source, "agent%"),
        ilike(notifications.source, "routine:%"),
      );
    case "flows":
      return or(
        ilike(notifications.source, "flow%"),
        ilike(notifications.source, "job:flow%"),
      );
    case "system":
      return dsql`${notifications.source} not ilike 'slack:%'
        and ${notifications.source} not ilike 'agent%'
        and ${notifications.source} not ilike 'routine:%'
        and ${notifications.source} not ilike 'flow%'
        and ${notifications.source} not ilike 'job:flow%'`;
    default:
      return undefined;
  }
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * The full notification history — where the bell's 15-row dropdown used to be
 * the only window into briefs, flow outputs and agent findings. Day-grouped,
 * source-filterable, and (via the search index) also reachable from ⌘K/Ask.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const { f } = await searchParams;
  const filter = (FILTERS.some((x) => x.id === f) ? f : "all") as FilterId;
  const where = filterWhere(filter);
  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(200);

  const groups: { label: string; items: typeof rows }[] = [];
  for (const n of rows) {
    const label = dayLabel(new Date(n.createdAt));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((x) => (
          <Link
            key={x.id}
            href={x.id === "all" ? "/notifications" : `/notifications?f=${x.id}`}
            className={cn(
              "rounded-lg border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
              filter === x.id
                ? "border-plasma/40 text-plasma"
                : "border-white/8 text-ink-faint hover:border-white/20 hover:text-ink-dim",
            )}
          >
            {x.label}
          </Link>
        ))}
        <div className="ml-auto">
          <MarkAllReadButton />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-14 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          nothing here yet
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.label}>
              <p className="mb-2 px-1 font-mono text-[9px] uppercase tracking-[0.28em] text-ink-faint">
                {g.label}
              </p>
              <div className="glass divide-y divide-white/4 overflow-hidden rounded-2xl">
                {g.items.map((n) => {
                  const inner = (
                    <div className={cn("px-4 py-3 transition hover:bg-white/3", !n.readAt && "bg-white/2")}>
                      <div className="flex items-center gap-2">
                        <span className="dot shrink-0" style={{ color: LEVEL_COLOR[n.level] }} />
                        <p className={cn("flex-1 text-sm", n.readAt ? "text-ink-dim" : "text-ink")}>
                          {n.title}
                        </p>
                        <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                          {new Date(n.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {n.body && (
                        <p className="mt-1 whitespace-pre-wrap pl-4 text-xs leading-relaxed text-ink-dim">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 pl-4 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                        {n.source}
                      </p>
                    </div>
                  );
                  return n.href ? (
                    <Link key={n.id} href={n.href} className="block">
                      {inner}
                    </Link>
                  ) : (
                    <div key={n.id}>{inner}</div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
