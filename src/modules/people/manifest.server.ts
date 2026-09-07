import type { ModuleServerManifest } from "@/core/modules/types.server";
import { people } from "./schema";
import { peopleTools } from "./tools";
import { peopleJobs } from "./jobs";
import { PeoplePage } from "./pages/PeoplePage";
import { PersonDetailPage } from "./pages/PersonDetailPage";

export const peopleServerManifest: ModuleServerManifest = {
  id: "people",
  routes: {
    "": PeoplePage,
    "[id]": PersonDetailPage,
  },
  // No dashboard widget — People lives on its own page (keeps the deck uncluttered).
  widgets: [],
  schema: { people },
  aiTools: peopleTools,
  jobs: peopleJobs,
  agentTemplates: [
    {
      id: "followup-tracker",
      name: "Follow-up tracker",
      description:
        "After your meetings, proposes the follow-ups worth doing — one card per person, into the 'Needs you' queue. Runs on a free local model.",
      defaultPrompt: [
        "You are the user's chief-of-staff handling post-meeting follow-ups. Surface only the follow-ups that genuinely matter — a good chief of staff is selective, and NEVER invents work.",
        "1. Call people.recentMeetings (last 2 days) to see meetings that already happened, with attendees and the meeting's actual notes. Call attention.list to see what follow-ups are already open (never duplicate).",
        "2. CRITICAL — a follow-up must be GROUNDED IN THE MEETING'S NOTES. Only consider meetings where hasNotes is true. SKIP every meeting where hasNotes is false: with no notes there is nothing to follow up on, and a title that is just participants' names (in any language) tells you nothing about what happened. Never guess or infer what a note-less meeting was about.",
        "3. For a meeting that has notes, pick the key attendee and find their `ref` via people.list (match on email — each person comes back with a short ref like 'p2'). Raise ONE follow-up with followup.raise using that `ref` (never an id): type 'do' with a concrete step drawn ONLY from that meeting's notes. Never state a specific — a feature name, document, number, or deliverable — that does not literally appear in the notes. Quote or closely paraphrase the notes; do not embellish.",
        "3a. If (and only if) the meeting notes reveal something durable worth remembering about that person, read their current note with people.get FIRST, then people.setNotes with the two MERGED — people.setNotes overwrites, so never blind-overwrite an existing note.",
        "4. Do not send anything — the cards are the output. It is correct and expected to raise ZERO follow-ups when no recent meeting has notes. Aim for at most 3-4, only when the notes genuinely warrant it.",
      ].join("\n"),
      defaultTools: [
        "people.recentMeetings",
        "people.list",
        "people.get",
        "followup.raise",
        "attention.list",
        "people.setNotes",
        "gmail.recent",
      ],
      defaultSchedule: "0 18 * * 1-5", // 18:00 weekdays, after the day's meetings
      defaultProvider: "ollama",
      defaultModel: "qwen3-coder:30b",
    },
    {
      id: "loose-ends-chaser",
      name: "Loose-ends chaser",
      description:
        "Twice a week, scans projects, tasks and people for things quietly slipping and surfaces the few worth catching. Free local model.",
      defaultPrompt: [
        "You are the user's chief-of-staff catching loose ends before they become problems. Be selective — surface the vital few, not everything.",
        "1. Read the world: projects.list (health, days since activity), tasks.list (overdue / stale), people.list (whom you haven't met in a while but usually do). Call attention.list to avoid duplicating open cards.",
        "2. Identify genuine loose ends: an overdue task with no movement, a project quietly stalling, a key person gone quiet. ",
        "3. Raise at most 2-3 cards with attention.raise: type 'do' with a concrete next step, or 'notify' for an FYI. To anchor a card to a project, pass its NAME (attention.raise's `project` field — validated server-side; never an id). Dedupe per ISO week: dedupeKey 'looseend:<slug>:<YYYY-Wxx>'.",
        "4. Do not repeat what the project-pulse already flags (stalled projects) unless you're adding a concrete action. Keep it minimal. If attention.list shows a loose-end card YOU raised whose situation has since resolved (the task moved, the person replied), close it with attention.resolve (status 'dismissed') by its ref.",
      ].join("\n"),
      defaultTools: [
        "projects.list",
        "tasks.list",
        "people.list",
        "attention.raise",
        "attention.list",
        "attention.resolve",
      ],
      defaultSchedule: "20 8 * * 1,4", // Mon & Thu 08:20 — staggered off Task triage (08:00)
      defaultProvider: "ollama",
      defaultModel: "qwen3-coder:30b",
    },
    {
      id: "weekly-reviewer",
      name: "Weekly reviewer",
      description:
        "Friday synthesis: what moved this week, what's slipping, and 2-3 priorities for next week — as one review card. Runs on a free local synthesis model.",
      defaultPrompt: [
        "You are the user's chief-of-staff writing their weekly review. Synthesize — don't just list.",
        "1. Gather: projects.list (health + progress), tasks.list (done vs open, overdue), people.list (who you met, who's gone quiet), attention.list (what's still open).",
        "2. Write a tight review: (a) what actually moved, (b) what's slipping or blocked, (c) 2-3 concrete priorities for next week. A few short paragraphs, specific, no filler.",
        "3. Raise exactly ONE card with attention.raise: type 'review', title 'Weekly review — <this week's Monday date>', the synthesis in the body, urgency 10, dedupeKey 'weekly:<YYYY-Wxx>'.",
        "4. Also call memory.remember to store the 2-3 priorities as a durable note so next week's agents know the focus.",
      ].join("\n"),
      defaultTools: [
        "projects.list",
        "tasks.list",
        "people.list",
        "attention.list",
        "attention.raise",
      ],
      defaultSchedule: "0 16 * * 5", // Friday 16:00
      // The one heavier synthesis job — still FREE and local.
      defaultProvider: "ollama",
      defaultModel: "gemma4:31b-it-qat",
    },
  ],
};
