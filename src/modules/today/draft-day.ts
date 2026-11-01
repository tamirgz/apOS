import type { TimeboxKind } from "./schema";
import type { TimeboxSettings } from "./timebox-settings";

/**
 * Draft my day — a deterministic fill of the day's free time with draft boxes.
 * Pure (no DB, no clock): the Plan screen passes in the day, the busy events,
 * the boxes already placed and the ordered candidates, and gets back new
 * draft boxes. Nothing already placed ever moves.
 */

const MIN = 60_000;
export const SLOT_MIN = 15;
/** A box this long or longer is followed by a short breather. */
const BUFFER_AFTER_MIN = 90;
const BUFFER_MIN = 10;
/** Inbox and Admin boxes are hard stops and never longer than this. */
const QUICK_MAX_MIN = 30;

export interface Interval {
  start: Date;
  end: Date;
}

export interface Candidate {
  /** "task:<uuid>" or "attention:<uuid>" — echoed back on the draft. */
  ref: string;
  title: string;
  kind: TimeboxKind;
  minutes: number;
}

export interface DraftBox extends Interval {
  ref: string;
  title: string;
  kind: TimeboxKind;
  endMode: "soft" | "hard";
}

/** Points → box length. Unestimated work gets an hour; 5+ is too big for one box. */
export function boxLength(points: number | null | undefined): { minutes: number; tooBig: boolean } {
  if (points == null || points <= 0) return { minutes: 60, tooBig: false };
  if (points === 1) return { minutes: 30, tooBig: false };
  if (points === 2) return { minutes: 60, tooBig: false };
  return { minutes: 90, tooBig: points >= 5 };
}

export const isQuick = (kind: TimeboxKind) => kind === "inbox" || kind === "admin";
export const endModeFor = (kind: TimeboxKind): "soft" | "hard" => (isQuick(kind) ? "hard" : "soft");

/** "HH:MM" on the given local day. */
export function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

export const ceilSlot = (d: Date) => new Date(Math.ceil(d.getTime() / (SLOT_MIN * MIN)) * SLOT_MIN * MIN);
const minutes = (i: Interval) => (i.end.getTime() - i.start.getTime()) / MIN;

/** Merge overlapping intervals, clipped to [from, to]. */
function merge(list: Interval[], from: Date, to: Date): Interval[] {
  const clipped = list
    .map((i) => ({
      start: new Date(Math.max(i.start.getTime(), from.getTime())),
      end: new Date(Math.min(i.end.getTime(), to.getTime())),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of clipped) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = new Date(Math.max(last.end.getTime(), i.end.getTime()));
    else out.push({ ...i });
  }
  return out;
}

/** [from, to] minus the given intervals. */
export function gaps(taken: Interval[], from: Date, to: Date): Interval[] {
  const out: Interval[] = [];
  let cur = from;
  for (const i of merge(taken, from, to)) {
    if (i.start > cur) out.push({ start: cur, end: i.start });
    if (i.end > cur) cur = i.end;
  }
  if (to > cur) out.push({ start: cur, end: to });
  return out;
}

/** A long box claims a breather after it, so nothing is drafted straight after. */
const withBuffer = (i: Interval): Interval =>
  minutes(i) >= BUFFER_AFTER_MIN ? { start: i.start, end: new Date(i.end.getTime() + BUFFER_MIN * MIN) } : i;

/**
 * The planning window for a day: from the boxable start (or now, on today)
 * to the work shutdown. Null when the day can't hold boxes or is over.
 */
export function workWindow(day: Date, now: Date, s: TimeboxSettings): Interval | null {
  if (!s.days.includes(day.getDay())) return null;
  const end = atTime(day, s.workEnd);
  const start = new Date(Math.max(atTime(day, s.start).getTime(), ceilSlot(now).getTime()));
  return start < end ? { start, end } : null;
}

/** Boxed minutes ÷ free minutes in the work window — the capacity meter. */
export function capacity(
  window: Interval | null,
  busy: Interval[],
  boxes: Interval[],
): { free: number; boxed: number } {
  if (!window) return { free: 0, boxed: 0 };
  const free = gaps(busy, window.start, window.end).reduce((n, g) => n + minutes(g), 0);
  const boxed = merge(boxes, window.start, window.end).reduce((n, i) => n + minutes(i), 0);
  return { free, boxed };
}

/** The earliest free slot of `len` minutes on the 15-minute grid inside [from, to], or null. */
export function firstSlot(len: number, from: Date, to: Date, taken: Interval[]): Interval | null {
  for (const g of gaps(taken, ceilSlot(from), to)) {
    const start = ceilSlot(g.start);
    const end = new Date(start.getTime() + len * MIN);
    if (end <= g.end) return { start, end };
  }
  return null;
}

export function draftDay(input: {
  day: Date;
  now: Date;
  settings: TimeboxSettings;
  /** Google events that block time (not free, not declined). */
  busy: Interval[];
  /** Every box already on the day — drafts and planned alike. Never moved. */
  placed: Interval[];
  /** In priority order: due, then Needs you, then the rest. */
  candidates: Candidate[];
}): DraftBox[] {
  const { day, now, settings: s, busy, placed, candidates } = input;
  const window = workWindow(day, now, s);
  if (!window) return [];

  const { free, boxed } = capacity(window, busy, placed);
  let budget = Math.floor(free * s.draftCap - boxed);
  const focus = { start: atTime(day, s.focusStart), end: atTime(day, s.focusEnd) };
  const taken: Interval[] = [...busy, ...placed.map(withBuffer)];
  const out: DraftBox[] = [];

  /** The earliest slot of `len` minutes inside [from, to] that clears everything taken. */
  const find = (len: number, from: Date, to: Date): Interval | null => {
    for (const g of gaps(taken, from, to)) {
      const start = ceilSlot(g.start);
      const end = new Date(start.getTime() + len * MIN);
      // A long box needs room for its breather too, unless the day ends there.
      const need = len >= BUFFER_AFTER_MIN && g.end < window.end ? BUFFER_MIN : 0;
      if (end.getTime() + need * MIN <= g.end.getTime()) return { start, end };
    }
    return null;
  };

  for (const c of candidates) {
    const len = isQuick(c.kind) ? Math.min(c.minutes, QUICK_MAX_MIN) : c.minutes;
    if (len > budget) continue;
    let slot: Interval | null = null;
    if (c.kind === "deep") {
      // Deep work goes into the focus window first.
      const from = new Date(Math.max(focus.start.getTime(), window.start.getTime()));
      const to = new Date(Math.min(focus.end.getTime(), window.end.getTime()));
      if (from < to) slot = find(len, from, to);
    } else if (focus.end > window.start && focus.end < window.end) {
      // Everything else keeps out of the focus window while it can.
      slot = find(len, focus.end, window.end);
    }
    slot ??= find(len, window.start, window.end);
    if (!slot) continue;
    out.push({ ...slot, ref: c.ref, title: c.title, kind: c.kind, endMode: endModeFor(c.kind) });
    taken.push(withBuffer(slot));
    budget -= len;
  }
  return out;
}
