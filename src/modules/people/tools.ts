import { z } from "zod";
import { db } from "@/core/db/client";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { registerRefs, resolveRef } from "@/core/ai/refs";
import { insertAttentionItem } from "@/modules/today/core";
import { ATTENTION_TYPES } from "@/modules/today/schema";
import {
  getPerson,
  listFollowupsForPerson,
  listPeople,
  recentMeetings,
} from "./queries";
import { meetingSubstance, quotesMeeting } from "./grounding";

const DAY = 86_400_000;
const daysAgo = (d: Date | null) =>
  d === null ? null : Math.floor((Date.now() - d.getTime()) / DAY);

export const peopleTools: AiToolDef[] = [
  {
    name: "people.list",
    description:
      "List the people you meet with (derived from calendar attendees): name, email, how many meetings, days since you last met, and open follow-up count. Read this to know who's active.",
    input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async execute(i: { limit?: number }, ctx: AiToolContext) {
      const rows = await listPeople(db);
      // Short handles (p1, p2…) — a follow-up or note targets the person by ref,
      // never a uuid, so it can't be written to the wrong person.
      return registerRefs(
        ctx,
        "person",
        "p",
        rows.slice(0, i.limit ?? 40).map((p) => ({
          id: p.id,
          name: p.name ?? p.email,
          email: p.email,
          meetings: p.meetingCount,
          daysSinceLastMet: daysAgo(p.lastSeenAt),
          openFollowups: p.openFollowups,
        })),
      );
    },
  },
  {
    name: "people.get",
    description:
      "Read ONE person in full — their durable notes, email, meeting count, days since you last met, and their open follow-ups. Identify them by their `ref` from people.list (e.g. 'p2'). Notes are written by the user only.",
    input: z.object({
      ref: z.string().describe("Person ref from people.list, e.g. 'p2'"),
    }),
    async execute(i: { ref: string }, ctx: AiToolContext) {
      const p = resolveRef(ctx, "person", i.ref);
      if ("error" in p) return p;
      const person = await getPerson(p.id, db);
      if (!person) return { error: "person not found" };
      const followups = await listFollowupsForPerson(p.id, db);
      return {
        name: person.name ?? person.email,
        email: person.email,
        notes: person.notes ?? null,
        meetings: person.meetingCount,
        daysSinceLastMet: daysAgo(person.lastSeenAt),
        openFollowups: followups.map((f) => ({ title: f.title, urgency: f.urgency })),
      };
    },
  },
  {
    name: "people.recentMeetings",
    description:
      "List meetings that already happened in the last N days (default 3), with attendees and the meeting's notes/agenda (logistics — parking, directions, call links — already stripped). A follow-up MUST quote `notes`: when `hasNotes` is false the invite says nothing about the meeting's substance (its title is often just participant names), so there is nothing real to follow up on — SKIP it and never invent a topic.",
    input: z.object({ days: z.number().int().min(1).max(30).optional() }),
    async execute(i: { days?: number }) {
      const rows = await recentMeetings(i.days ?? 3, db);
      return rows.map((m) => {
        const attendees = (m.attendees ?? [])
          .filter((a) => !a.self)
          .map((a) => ({ name: a.name ?? a.email, email: a.email }));
        const notes = meetingSubstance(m.notes);
        return { title: m.title, at: m.startAt, notes: notes || null, hasNotes: notes.length > 0, attendees };
      });
    },
  },
  {
    name: "followup.raise",
    description:
      "Raise a follow-up as a card in the 'Needs you' queue, anchored to a person. `quote` is REQUIRED: copy, word for word, the sentence from the `notes` of a meeting this person attended (people.recentMeetings) that the follow-up comes from — a card with no quote from that person's own meeting is refused. Use type 'do' for a concrete step you should take, 'approve' only when a real side-effect (e.g. sending a message) needs sign-off, 'notify' for an FYI. Deduplication is automatic — at most one open card per (person + title), so re-running never duplicates; you don't need to manage a key.",
    input: z.object({
      ref: z.string().describe("Person ref from people.list, e.g. 'p2' — never a raw id"),
      type: z.enum(ATTENTION_TYPES).default("do"),
      title: z.string().min(3),
      quote: z
        .string()
        .describe("The exact sentence from this person's meeting notes the follow-up comes from"),
      body: z.string().optional(),
      urgency: z.number().int().min(0).max(100).optional(),
      dedupeKey: z.string().optional(),
    }),
    async execute(
      i: {
        ref: string;
        type: (typeof ATTENTION_TYPES)[number];
        title: string;
        quote: string;
        body?: string;
        urgency?: number;
        dedupeKey?: string;
      },
      ctx: AiToolContext,
    ) {
      const p = resolveRef(ctx, "person", i.ref);
      if ("error" in p) return p;
      // Grounding is enforced here, not trusted to the prompt: the quote must be
      // in the substance of a recent meeting THIS person attended. Stops
      // follow-ups spun from logistics, from another meeting, or from nothing.
      const person = await getPerson(p.id, db);
      const email = person?.email.toLowerCase();
      const meetings = email ? await recentMeetings(7, db) : [];
      const grounded = meetings.some(
        (m) =>
          (m.attendees ?? []).some((a) => a.email?.toLowerCase() === email) &&
          quotesMeeting(i.quote, m.notes),
      );
      if (!grounded)
        return {
          error:
            "not raised — that quote isn't in the notes of a meeting this person attended in the last 7 days. A follow-up needs the meeting's own words; without them, there is no follow-up for this person.",
        };
      const body = [i.body?.trim(), `From the meeting: “${i.quote.trim()}”`].filter(Boolean).join("\n\n");
      const row = await insertAttentionItem({
        type: i.type,
        title: i.title,
        body,
        personRef: `people:${p.id}`,
        href: `/m/people/${p.id}`,
        urgency: i.urgency ?? 15,
        dedupeKey: i.dedupeKey,
        source: "agent",
      });
      return { id: row.id, raised: true };
    },
  },
];
