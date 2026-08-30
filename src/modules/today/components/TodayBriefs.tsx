import Link from "next/link";
import { and, desc, gte, or, ilike } from "drizzle-orm";
import { db } from "@/core/db/client";
import { notifications } from "@/core/db/schema/notifications";
import { Markdown } from "@/core/ui/Markdown";

/** Per-block bidi: a Hebrew line aligns right, an English one left — briefs
 *  mix both. `unicode-bidi: plaintext` is per-element, so target the blocks. */
const BIDI =
  "[&_p]:[unicode-bidi:plaintext] [&_li]:[unicode-bidi:plaintext] [&_h1]:[unicode-bidi:plaintext] [&_h2]:[unicode-bidi:plaintext] [&_h3]:[unicode-bidi:plaintext]";

/**
 * Today's briefs, on the morning surface — the Daily brief, Slack-ingested
 * routine reports (#my-today, #tldr), flow outputs and agent findings from
 * TODAY. These used to live only in the bell's 15-row dropdown; the day's
 * intelligence now sits where the day starts. Bodies expand natively
 * (<details>), full history lives at /notifications.
 */
export async function TodayBriefs() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        gte(notifications.createdAt, startOfDay),
        or(
          ilike(notifications.source, "slack:%"),
          ilike(notifications.source, "agent%"),
          ilike(notifications.source, "routine:%"),
          ilike(notifications.source, "flow%"),
          ilike(notifications.source, "job:flow%"),
        ),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(8);

  if (rows.length === 0) return null;

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 px-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
          today&apos;s briefs
        </p>
        <span className="font-mono text-[10px] text-ion">{rows.length}</span>
        <Link
          href="/notifications?f=briefs"
          className="ml-auto font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:text-plasma"
        >
          history →
        </Link>
      </div>
      <div className="glass divide-y divide-white/4 overflow-hidden rounded-xl">
        {rows.map((n) =>
          n.body ? (
            <details key={n.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 transition hover:bg-white/3 [&::-webkit-details-marker]:hidden">
                <span className="dot shrink-0 text-ion" />
                <span dir="auto" className="flex-1 truncate text-sm text-ink">
                  {n.title}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  {n.source}
                </span>
                <span className="shrink-0 font-mono text-[9px] text-ink-faint transition group-open:rotate-180">
                  ▾
                </span>
              </summary>
              <div className={`px-3 pb-3 pl-7 ${BIDI}`}>
                <Markdown>{n.body}</Markdown>
              </div>
            </details>
          ) : (
            <div key={n.id} className="flex items-center gap-2 px-3 py-2.5">
              <span className="dot shrink-0 text-ion" />
              <span className="flex-1 truncate text-sm text-ink">{n.title}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                {n.source}
              </span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
