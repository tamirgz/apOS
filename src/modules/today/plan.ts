import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { calendarEvents } from "@/modules/calendar/schema";
import { ACTIVE_STATUSES, OPEN_STATUSES, priorityRank, tasks } from "@/modules/tasks/schema";
import { identifierOf, projectKeyMap } from "@/modules/tasks/core";
import { projects } from "@/modules/projects/schema";
import { boxLength, capacity, workWindow, type Candidate, type Interval } from "./draft-day";
import { attentionItems, timeboxes, type Timebox, type TimeboxKind } from "./schema";
import { getTimeboxSettings, type TimeboxSettings } from "./timebox-settings";
import { openTime } from "./timeline";

/**
 * Data for the Plan screen (timeboxing Phase 1): one local day's busy time,
 * boxes and the work that could fill it. Worker-safe — no `use server`.
 */

/** The assignee value that means "the user" — set by ★ and by boxing an item. */
export const ME = "me";
/** Due/overdue items shown on the Plan screen; the rest are counted, not listed. */
const DUE_LIMIT = 30;

export interface BusyBlock extends Interval {
  id: string;
  title: string;
  color: string | null;
  source: "local" | "ics" | "google";
}

export interface PlanCandidate {
  /** "task:<uuid>" or "attention:<uuid>". */
  ref: string;
  title: string;
  /** "ETHOS-12" for work items. */
  identifier: string | null;
  /** The work item's project name. */
  project: string | null;
  /** The estimate in points, when there is one. */
  points: number | null;
  href: string | null;
  kind: TimeboxKind;
  minutes: number;
  /** 5+ points: one box won't hold it. */
  tooBig: boolean;
  due: Date | null;
  mine: boolean;
  /** Already has a box on this day. */
  boxed: boolean;
}

export interface PlanDay {
  /** "YYYY-MM-DD", local. */
  date: string;
  isToday: boolean;
  settings: TimeboxSettings;
  busy: BusyBlock[];
  allDay: { id: string; title: string }[];
  boxes: Timebox[];
  /** Box id → the project name of its work item. */
  boxProjects: Record<string, string>;
  due: PlanCandidate[];
  dueMore: number;
  mine: PlanCandidate[];
  needs: PlanCandidate[];
  /**
   * Minutes before the work shutdown, for the time bar: free (not in a meeting),
   * boxed, short buffers between things, and the unboxed rest.
   */
  capacity: { free: number; boxed: number; buffers: number; unboxed: number };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "YYYY-MM-DD" → local midnight; anything else → today. */
export function parseDay(s: string | null | undefined): Date {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  if (Number.isNaN(d.getTime())) return parseDay(null);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function dayRange(day: Date): Interval {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/** Work items: 2+ points is focus work; the rest is shallow. */
export const taskKind = (points: number | null): TimeboxKind => (points != null && points >= 2 ? "deep" : "shallow");

/** Google events that block time on the day: not all-day, not "free", not declined. */
export async function busyOn(day: Date): Promise<{ busy: BusyBlock[]; allDay: { id: string; title: string }[] }> {
  const { start, end } = dayRange(day);
  const rows = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      allDay: calendarEvents.allDay,
      transparent: calendarEvents.transparent,
      color: calendarEvents.color,
      source: calendarEvents.source,
      attendees: calendarEvents.attendees,
    })
    .from(calendarEvents)
    .where(
      and(
        lt(calendarEvents.startAt, end),
        or(gt(calendarEvents.endAt, start), and(sql`${calendarEvents.endAt} is null`, gte(calendarEvents.startAt, start))),
      ),
    )
    .orderBy(asc(calendarEvents.startAt));

  const declined = (r: (typeof rows)[number]) =>
    (r.attendees ?? []).some((a) => a.self && a.responseStatus === "declined");
  return {
    busy: rows
      .filter((r) => !r.allDay && !r.transparent && !declined(r))
      .map((r) => ({
        id: r.id,
        title: r.title,
        start: r.startAt,
        end: r.endAt ?? new Date(r.startAt.getTime() + 30 * 60_000),
        color: r.color,
        source: r.source,
      })),
    allDay: rows.filter((r) => r.allDay && !declined(r)).map((r) => ({ id: r.id, title: r.title })),
  };
}

/** The day's boxes, except dropped ones. */
export async function boxesOn(day: Date): Promise<Timebox[]> {
  const { start, end } = dayRange(day);
  return db
    .select()
    .from(timeboxes)
    .where(and(gte(timeboxes.startAt, start), lt(timeboxes.startAt, end), ne(timeboxes.status, "dropped")))
    .orderBy(asc(timeboxes.startAt));
}

export async function getPlanDay(dayParam?: string | null): Promise<PlanDay> {
  const day = parseDay(dayParam);
  const { start, end } = dayRange(day);
  const [settings, { busy, allDay }, boxes, keys, projectRows] = await Promise.all([
    getTimeboxSettings(),
    busyOn(day),
    boxesOn(day),
    projectKeyMap(db),
    db.select({ id: projects.id, name: projects.name }).from(projects),
  ]);
  const projectNames = new Map(projectRows.map((p) => [`projects:${p.id}`, p.name]));
  const boxedTasks = new Set(boxes.map((b) => b.taskId).filter(Boolean));
  const boxedCards = new Set(boxes.map((b) => b.attentionId).filter(Boolean));

  const taskCols = {
    id: tasks.id,
    title: tasks.title,
    shortTitle: tasks.shortTitle,
    projectRef: tasks.projectRef,
    number: tasks.number,
    estimate: tasks.estimate,
    dueAt: tasks.dueAt,
    assignee: tasks.assignee,
  };
  const dueWhere = and(inArray(tasks.status, [...ACTIVE_STATUSES]), isNotNull(tasks.dueAt), lt(tasks.dueAt, end));
  const [due, [{ dueCount }], mine, cards] = await Promise.all([
    // Yours first, then what falls due on this day, then the overdue backlog —
    // so a long overdue tail never hides the day's own deadlines.
    db
      .select(taskCols)
      .from(tasks)
      .where(dueWhere)
      .orderBy(
        sql`coalesce(${tasks.assignee} = ${ME}, false) desc`,
        sql`${tasks.dueAt} >= ${start.toISOString()} desc`,
        asc(tasks.dueAt),
        priorityRank,
      )
      .limit(DUE_LIMIT),
    db.select({ dueCount: sql<number>`count(*)::int` }).from(tasks).where(dueWhere),
    db
      .select(taskCols)
      .from(tasks)
      .where(
        and(
          eq(tasks.assignee, ME),
          inArray(tasks.status, [...OPEN_STATUSES]),
          // Mine-and-due items are listed under Due.
          or(sql`${tasks.dueAt} is null`, gte(tasks.dueAt, end)),
        ),
      )
      .orderBy(priorityRank, asc(tasks.dueAt))
      .limit(50),
    db
      .select({ id: attentionItems.id, title: attentionItems.title, urgency: attentionItems.urgency })
      .from(attentionItems)
      .where(eq(attentionItems.status, "open"))
      .orderBy(desc(attentionItems.urgency), desc(attentionItems.createdAt))
      .limit(20),
  ]);

  const fromTask = (t: (typeof due)[number]): PlanCandidate => {
    const { minutes, tooBig } = boxLength(t.estimate);
    return {
      ref: `task:${t.id}`,
      title: t.shortTitle || t.title,
      identifier: identifierOf(t, keys),
      project: (t.projectRef && projectNames.get(t.projectRef)) || null,
      points: t.estimate,
      href: `/m/tasks/${t.id}`,
      kind: taskKind(t.estimate),
      minutes,
      tooBig,
      due: t.dueAt,
      mine: t.assignee === ME,
      boxed: boxedTasks.has(t.id),
    };
  };
  const today = parseDay(null);
  const window = workWindow(day, new Date(), settings);
  const boxSpans = boxes.map((b) => ({ start: b.startAt, end: b.endAt }));
  const { free, boxed } = capacity(window, busy, boxSpans);
  const buffers = window
    ? openTime([...busy, ...boxSpans], window.start, window.end)
        .filter((g) => g.kind === "buffer")
        .reduce((n, g) => n + g.minutes, 0)
    : 0;

  return {
    date: localDate(day),
    isToday: day.getTime() === today.getTime(),
    settings,
    busy,
    allDay,
    boxes,
    boxProjects: await boxProjectsOf(boxes, projectNames),
    due: due.map(fromTask),
    dueMore: Math.max(0, dueCount - due.length),
    mine: mine.map(fromTask),
    needs: cards.map((c) => ({
      ref: `attention:${c.id}`,
      title: c.title,
      identifier: null,
      project: null,
      points: null,
      href: "/m/today/queue",
      kind: "admin" as const,
      minutes: 30,
      tooBig: false,
      due: null,
      mine: true,
      boxed: boxedCards.has(c.id),
    })),
    capacity: { free, boxed, buffers, unboxed: Math.max(0, free - boxed - buffers) },
  };
}

/** Box id → its work item's project name, for the box's second line. */
async function boxProjectsOf(boxes: Timebox[], names: Map<string, string>): Promise<Record<string, string>> {
  const ids = [...new Set(boxes.map((b) => b.taskId).filter((id): id is string => !!id))];
  if (!ids.length) return {};
  const rows = await db.select({ id: tasks.id, projectRef: tasks.projectRef }).from(tasks).where(inArray(tasks.id, ids));
  const byTask = new Map(rows.map((r) => [r.id, r.projectRef ? names.get(r.projectRef) : undefined]));
  const out: Record<string, string> = {};
  for (const b of boxes) {
    const name = b.taskId ? byTask.get(b.taskId) : undefined;
    if (name) out[b.id] = name;
  }
  return out;
}

/**
 * What Draft my day may place, in order: your due/overdue items, then the
 * Needs-you cards, then the rest of your items. Only ★ Mine work — a due item
 * nobody claimed stays on the list for you to drag, never auto-drafted.
 */
export function draftCandidates(p: PlanDay): Candidate[] {
  const open = (c: PlanCandidate) => !c.boxed;
  return [...p.due.filter((c) => c.mine), ...p.needs, ...p.mine]
    .filter(open)
    .map((c) => ({ ref: c.ref, title: c.title, kind: c.kind, minutes: c.minutes }));
}

/** Ids of the day's boxes — for actions that act on "this day's drafts". */
export async function draftIdsOn(day: Date): Promise<string[]> {
  const { start, end } = dayRange(day);
  const rows = await db
    .select({ id: timeboxes.id })
    .from(timeboxes)
    .where(and(gte(timeboxes.startAt, start), lt(timeboxes.startAt, end), eq(timeboxes.status, "draft")));
  return rows.map((r) => r.id);
}
