/**
 * Worker-safe core for the people table (no "use server", no next/cache).
 * Derives one row per distinct calendar attendee — "observe, don't ask to be
 * fed": the user never types a contact. A full recompute over the synced
 * window, idempotent, upserting on email.
 */
import { db, sql } from "@/core/db/client";

/** Rebuild the people table from calendar attendees. Returns rows touched. */
export async function syncPeopleFromCalendar(): Promise<number> {
  const rows = await sql`
    insert into people (email, name, meeting_count, first_seen_at, last_seen_at, last_event_title, updated_at)
    select
      lower(a->>'email')                                                as email,
      -- "Eyal gr <eyal.gr@gmail.com>" → "Eyal gr": some invites embed the address in the name.
      (array_remove(array_agg(nullif(trim(regexp_replace(a->>'name', '\\s*<[^>]*>\\s*$', '')), '') order by ce.start_at desc), null))[1] as name,
      count(*)::int                                                     as meeting_count,
      min(ce.start_at)                                                  as first_seen_at,
      max(ce.start_at)                                                  as last_seen_at,
      (array_agg(ce.title order by ce.start_at desc))[1]               as last_event_title,
      now()
    from calendar_events ce, jsonb_array_elements(ce.attendees) a
    where ce.attendees is not null
      and coalesce(a->>'email', '') <> ''
      and coalesce((a->>'self')::boolean, false) = false
    group by lower(a->>'email')
    on conflict (email) do update set
      name             = coalesce(excluded.name, people.name),
      meeting_count    = excluded.meeting_count,
      first_seen_at    = least(people.first_seen_at, excluded.first_seen_at),
      last_seen_at     = greatest(people.last_seen_at, excluded.last_seen_at),
      last_event_title = excluded.last_event_title,
      updated_at       = now()
    returning id
  `;
  await sql.notify("people_changed", "");
  return rows.length;
}

/** Keep a handle on db for callers that want it worker-safe alongside core. */
export { db };
