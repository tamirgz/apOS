import { displayName } from "../display";
import Link from "next/link";
import { ArrowLeft, CalendarClock } from "lucide-react";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { getPerson, getPersonMeetings, listFollowupsForPerson } from "../queries";
import { PersonNotes } from "../components/PersonNotes";

function fmt(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function PersonDetailPage({ params }: ModuleRouteProps) {
  const [id] = params;
  const person = await getPerson(id);

  if (!person) {
    return (
      <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          not found
        </p>
        <Link
          href="/m/people"
          className="mt-2 rounded-lg border border-ion/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-ion transition hover:bg-ion/10"
        >
          back to people
        </Link>
      </GlassPanel>
    );
  }

  const [meetings, followups] = await Promise.all([
    getPersonMeetings(person.email, 20),
    listFollowupsForPerson(id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/m/people"
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          people
        </Link>
        <h1 className="font-display text-3xl font-semibold text-ink">
          {displayName(person)}
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-dim">{person.email}</p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {person.meetingCount} meetings · first {fmt(person.firstSeenAt)} · last{" "}
          {fmt(person.lastSeenAt)}
        </p>
      </header>

      <PersonNotes personId={person.id} initial={person.notes} />

      {followups.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-solar">
            open follow-ups
          </h2>
          {followups.map((f) => (
            <div
              key={f.id}
              className="glass flex items-start gap-2.5 rounded-xl border-l-2 border-solar/50 p-3"
            >
              <div className="flex-1">
                <p className="text-sm text-ink">{f.title}</p>
                {f.body && (
                  <p className="mt-0.5 text-xs leading-snug text-ink-dim">{f.body}</p>
                )}
              </div>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                {f.type}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
          meetings
        </h2>
        {meetings.map((m) => (
          <div key={m.id} className="glass flex items-center gap-3 rounded-xl p-3">
            <CalendarClock className="size-4 shrink-0 text-ink-faint" />
            <span className="flex-1 truncate text-sm text-ink-dim">{m.title}</span>
            <span className="shrink-0 font-mono text-[10px] text-ink-faint">
              {fmt(m.startAt)}
            </span>
          </div>
        ))}
        {meetings.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/6 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            no meetings in the synced window
          </div>
        )}
      </section>
    </div>
  );
}
