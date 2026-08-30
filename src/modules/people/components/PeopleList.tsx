"use client";

import { dayAgo } from "@/core/ui/time";

import Link from "next/link";
import { useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw, Users } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { resyncPeople } from "../actions";
import type { PersonWithFollowups } from "../queries";

const lastMet = (d: Date | null) => dayAgo(d);

function initials(name: string): string {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
}

export function PeopleList({ people }: { people: PersonWithFollowups[] }) {
  const [pending, start] = useTransition();

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          <Users className="size-3.5 text-ion" />
          {people.length} people · from your calendar
        </p>
        <button
          type="button"
          onClick={() => start(async () => void (await resyncPeople()))}
          disabled={pending}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3", pending && "animate-spin")} />
          {pending ? "syncing…" : "resync"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <AnimatePresence mode="popLayout">
          {people.map((p) => (
            <motion.div
              key={p.id}
              layout
              layoutId={p.id}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            >
              <Link
                href={`/m/people/${p.id}`}
                className="glass flex items-center gap-3 rounded-xl p-3.5 transition hover:bg-white/4"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ion/15 font-mono text-[11px] font-medium text-ion">
                  {initials(p.name ?? p.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {p.name ?? p.email}
                  </p>
                  <p className="truncate font-mono text-[10px] text-ink-faint">
                    {p.meetingCount} mtg · {lastMet(p.lastSeenAt)}
                  </p>
                </div>
                {p.openFollowups > 0 && (
                  <span
                    className="shrink-0 rounded-md border border-solar/30 bg-solar/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-solar"
                    title="open follow-ups"
                  >
                    {p.openFollowups}
                  </span>
                )}
              </Link>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {people.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/6 py-12 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          no people yet — connect Google Calendar, then resync
        </div>
      )}
    </div>
  );
}
