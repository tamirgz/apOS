import Link from "next/link";
import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { modules } from "@/modules/registry";
import { cn } from "@/core/ui/cn";

type Row = Record<string, unknown>;
const rowsOf = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

/**
 * Things you create, per module — the write-side usage signal. It works from
 * day one (it doesn't need the beacon to have been running), which is how the
 * 2026-09 usage review was reconstructed. `table` must be a trusted literal.
 */
const WRITE_SURFACES: { module: string; label: string; table: string }[] = [
  { module: "tasks", label: "Work items", table: "tasks" },
  { module: "ask", label: "Ask questions", table: "ask_history" },
  { module: "inbox", label: "Inbox captures", table: "inbox_items" },
  { module: "knowledge", label: "Knowledge captures", table: "knowledge_items" },
  { module: "ideas", label: "Ideas", table: "ideas" },
  { module: "notes", label: "Notes", table: "notes" },
  { module: "workbench", label: "Runs", table: "workbench_tasks" },
  { module: "studio", label: "Flows", table: "flows" },
  { module: "workbench", label: "Routines", table: "routines" },
  { module: "chat", label: "Chats", table: "chat_runs" },
];

const DAY = 86_400_000;
function ago(d: unknown): string {
  if (!d) return "never";
  const days = Math.floor((Date.now() - +new Date(String(d))) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
const stale = (d: unknown, days = 21) => !d || Date.now() - +new Date(String(d)) > days * DAY;

/** Settings · Activity — what you actually use, from local telemetry + write traces. */
export async function ActivityPanel() {
  const [since, views, actions, cards, ...writes] = await Promise.all([
    db.execute(dsql`select min(ts) as first from ui_events`),
    db.execute(dsql`
      select split_part(coalesce(meta->>'route', path), '/', 3) as module,
             count(*)::int as n, max(ts) as last
        from ui_events
       where event = 'view' and ts > now() - interval '30 days'
         and coalesce(meta->>'route', path) like '/m/%'
       group by 1`),
    db.execute(dsql`
      select event, count(*)::int as n, max(ts) as last
        from ui_events
       where event <> 'view' and ts > now() - interval '30 days'
       group by 1 order by n desc`),
    db.execute(dsql`
      select source,
             count(*)::int as raised,
             count(*) filter (where status = 'done')::int as done,
             count(*) filter (where status = 'dismissed')::int as dismissed,
             count(*) filter (where status = 'expired')::int as expired,
             count(*) filter (where status in ('open','snoozed'))::int as open
        from attention_items
       where created_at > now() - interval '30 days'
       group by 1 order by raised desc`),
    ...WRITE_SURFACES.map((w) =>
      db.execute(
        dsql.raw(
          `select count(*) filter (where created_at > now() - interval '30 days')::int as n30, max(created_at) as last from ${w.table}`,
        ),
      ),
    ),
  ]);

  const firstTs = rowsOf<{ first: string | null }>(since)[0]?.first ?? null;
  const viewRows = rowsOf<{ module: string; n: number; last: string }>(views);
  const viewBy = new Map(viewRows.map((v) => [v.module, v]));
  const navModules = modules.filter((m) => m.nav);
  const moduleRows = navModules
    .map((m) => ({ id: m.id, title: m.title, n: viewBy.get(m.id)?.n ?? 0, last: viewBy.get(m.id)?.last ?? null }))
    .sort((a, b) => b.n - a.n);
  const maxViews = Math.max(1, ...moduleRows.map((m) => m.n));
  const writeRows = WRITE_SURFACES.map((w, i) => ({ ...w, ...(rowsOf<Row>(writes[i])[0] ?? {}) })) as Array<
    (typeof WRITE_SURFACES)[number] & { n30?: number; last?: string | null }
  >;
  const cardRows = rowsOf<{ source: string; raised: number; done: number; dismissed: number; expired: number; open: number }>(cards);
  const actionRows = rowsOf<{ event: string; n: number; last: string }>(actions);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-dim">
        Local only — nothing leaves your database. Page views and key actions are recorded
        {firstTs ? ` since ${new Date(firstTs).toLocaleDateString()}` : " from now on"}; the
        &ldquo;things you create&rdquo; table reads existing records, so it covers all history.
      </p>

      <section className="flex flex-col gap-2.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          page visits — last 30 days
        </h3>
        <div className="glass grid gap-x-6 gap-y-1.5 rounded-xl p-4 sm:grid-cols-2">
          {moduleRows.map((m) => (
            <Link
              key={m.id}
              href={`/m/${m.id}`}
              className="grid grid-cols-[7.5rem_1fr_2.5rem_4.5rem] items-center gap-2 text-sm"
            >
              <span className={cn("truncate", m.n ? "text-ink-dim" : "text-ink-faint")}>{m.title}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-white/6">
                <span
                  className="block h-full rounded-full bg-plasma/70"
                  style={{ width: `${(m.n / maxViews) * 100}%` }}
                />
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-ink">{m.n}</span>
              <span className="text-right font-mono text-[10px] text-ink-faint">{m.n ? ago(m.last) : "—"}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          things you create
        </h3>
        <div className="glass rounded-xl p-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                <th className="pb-2 text-left font-normal">surface</th>
                <th className="pb-2 text-right font-normal">last 30d</th>
                <th className="pb-2 text-right font-normal">last used</th>
              </tr>
            </thead>
            <tbody>
              {writeRows.map((w) => (
                <tr key={w.table} className="border-t border-white/4">
                  <td className="py-1.5 text-ink-dim">
                    {w.label}
                    {stale(w.last) && (
                      <span className="ml-2 rounded border border-solar/30 px-1.5 py-px font-mono text-[9px] uppercase tracking-widest text-solar">
                        dormant
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink">{w.n30 ?? 0}</td>
                  <td className="py-1.5 text-right font-mono text-xs text-ink-faint">{ago(w.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          cards raised for you — last 30 days
        </h3>
        <div className="glass rounded-xl p-3">
          {cardRows.length === 0 ? (
            <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">no cards</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  <th className="pb-2 text-left font-normal">raised by</th>
                  <th className="pb-2 text-right font-normal">raised</th>
                  <th className="pb-2 text-right font-normal">acted on</th>
                  <th className="pb-2 text-right font-normal">dismissed</th>
                  <th className="pb-2 text-right font-normal">expired</th>
                  <th className="pb-2 text-right font-normal">open</th>
                </tr>
              </thead>
              <tbody>
                {cardRows.map((c) => {
                  const closed = c.done + c.dismissed + c.expired;
                  const acted = closed ? Math.round((c.done / closed) * 100) : null;
                  return (
                    <tr key={c.source} className="border-t border-white/4">
                      <td className="py-1.5 text-ink-dim">{c.source}</td>
                      <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink">{c.raised}</td>
                      <td className="py-1.5 text-right font-mono text-xs tabular-nums">
                        <span className={acted !== null && acted < 25 ? "text-flare" : "text-plasma"}>
                          {c.done}
                          {acted !== null && <span className="text-ink-faint"> · {acted}%</span>}
                        </span>
                      </td>
                      <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">{c.dismissed}</td>
                      <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">{c.expired}</td>
                      <td className="py-1.5 text-right font-mono text-xs tabular-nums text-ink-dim">{c.open}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <p className="px-1 font-mono text-[9px] leading-relaxed text-ink-faint">
          Acted on = marked done, as a share of closed cards. Agent cards nobody touches expire after
          7 days. A source that stays near 0% is noise worth turning off.
        </p>
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          key actions — last 30 days
        </h3>
        <div className="glass rounded-xl p-3">
          {actionRows.length === 0 ? (
            <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              nothing recorded yet
            </p>
          ) : (
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {actionRows.map((a) => (
                <div key={a.event} className="flex items-center gap-2 text-sm">
                  <span className="truncate font-mono text-xs text-ink-dim">{a.event}</span>
                  <span className="ml-auto font-mono text-xs tabular-nums text-ink">{a.n}</span>
                  <span className="w-16 text-right font-mono text-[10px] text-ink-faint">{ago(a.last)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
