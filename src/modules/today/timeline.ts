import { gaps, type Interval } from "./draft-day";

/**
 * Layout for the day timeline (Plan screen, Calendar week, Today's Now strip).
 * Pure — no DB, no React — so the scheduler test covers it.
 */

const MIN = 60_000;
/** A gap this short reads as a breather between two things, not open time. */
export const BUFFER_MAX = 20;
/** Gaps shorter than this aren't worth a label. */
const GAP_MIN = 5;

export interface Gap extends Interval {
  minutes: number;
  kind: "buffer" | "unboxed";
}

/** The open time in [from, to] between busy events and boxes: short gaps are buffers, longer ones unboxed time. */
export function openTime(taken: Interval[], from: Date, to: Date): Gap[] {
  if (to <= from) return [];
  return gaps(taken, from, to)
    .map((g) => {
      const minutes = Math.round((g.end.getTime() - g.start.getTime()) / MIN);
      return { ...g, minutes, kind: minutes <= BUFFER_MAX ? ("buffer" as const) : ("unboxed" as const) };
    })
    .filter((g) => g.minutes >= GAP_MIN);
}

/** Where a block sits across its day column: lane `lane` of `of` side-by-side lanes. */
export interface Lane {
  lane: number;
  of: number;
}

/** Side-by-side lanes for overlapping blocks, the way a calendar's day column lays out clashes. */
export function lanes(items: { start: number; end: number }[]): Lane[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[b].end - items[a].end);
  const out: Lane[] = new Array(items.length);
  let cluster: number[] = [];
  let ends: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const i of cluster) out[i].of = ends.length;
    cluster = [];
    ends = [];
  };
  for (const i of order) {
    const { start, end } = items[i];
    if (start >= clusterEnd) flush();
    let lane = ends.findIndex((e) => e <= start);
    if (lane === -1) lane = ends.push(end) - 1;
    else ends[lane] = end;
    out[i] = { lane, of: 1 };
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}
