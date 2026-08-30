import Link from "next/link";
import { desc, inArray, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { inboxItems } from "../schema";

export async function InboxWidget() {
  // "failed" is the live failure status; "error" is the legacy marker — the
  // widget counted only the legacy one, so failed triage never showed here.
  const [pendingCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(inboxItems)
    .where(inArray(inboxItems.status, ["failed", "error"]));
  const recent = await db
    .select()
    .from(inboxItems)
    .orderBy(desc(inboxItems.createdAt))
    .limit(3);

  return (
    <div className="flex h-full flex-col gap-3">
      <Link
        href="/m/inbox"
        className="font-display text-3xl font-semibold text-ink transition hover:text-solar"
      >
        {recent.length === 0 ? "∅" : recent.length}
        <span className="ml-2 text-sm font-normal tracking-widest text-ink-dim">
          recent
        </span>
      </Link>
      {Number(pendingCount.n) > 0 && (
        <p className="font-mono text-[10px] uppercase tracking-widest text-flare">
          {Number(pendingCount.n)} failed triage
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {recent.map((r) => (
          <li
            key={r.id}
            className="truncate font-mono text-[11px] text-ink-faint"
          >
            {r.input.slice(0, 60)}
          </li>
        ))}
      </ul>
    </div>
  );
}
