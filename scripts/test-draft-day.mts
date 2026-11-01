/**
 * Draft my day — the pure scheduler, no DB.
 *
 *   pnpm test:draft
 */
import { boxLength, capacity, draftDay, firstSlot, workWindow, type Candidate, type Interval } from "../src/modules/today/draft-day";
import { TIMEBOX_DEFAULTS } from "../src/modules/today/timebox-settings";
import { lanes, openTime } from "../src/modules/today/timeline";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

// Monday 2026-11-02 — a work day under the defaults (Sun–Fri).
const DAY = new Date(2026, 10, 2);
const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m);
const iv = (a: [number, number], b: [number, number]): Interval => ({ start: at(...a), end: at(...b) });
const EARLY = new Date(2026, 10, 2, 7, 0);
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const cand = (n: number, kind: Candidate["kind"], minutes = 60): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ ref: `task:${kind}${i}`, title: `${kind} ${i}`, kind, minutes }));
const run = (o: Partial<Parameters<typeof draftDay>[0]>) =>
  draftDay({ day: DAY, now: EARLY, settings: TIMEBOX_DEFAULTS, busy: [], placed: [], candidates: [], ...o });

// Box lengths from points.
check(
  "points map to 30 / 60 / 90 / 90+split / 60",
  [1, 2, 3, 5, 8, null].map((p) => `${boxLength(p).minutes}${boxLength(p).tooBig ? "!" : ""}`).join(",") === "30,60,90,90!,90!,60",
);

// 1. The cap: never more than 75% of the free time before 18:00.
{
  const busy = [iv([13, 0], [14, 0])];
  const out = run({ busy, candidates: cand(20, "shallow") });
  const { free, boxed } = capacity(workWindow(DAY, EARLY, TIMEBOX_DEFAULTS), busy, out);
  check("the 75% cap is respected", free === 480 && boxed <= 0.75 * free && boxed >= 0.75 * free - 60, { free, boxed });
}

// 2. Deep work lands in the 09:00–12:00 focus window; shallow work stays out of it.
{
  const out = run({ candidates: [...cand(1, "shallow"), ...cand(3, "deep", 60)] });
  const deep = out.filter((b) => b.kind === "deep");
  check(
    "deep work lands in the focus window",
    deep.length === 3 && deep.every((b) => b.start >= at(9) && b.end <= at(12)),
    deep.map((b) => `${hhmm(b.start)}-${hhmm(b.end)}`),
  );
  const shallow = out.find((b) => b.kind === "shallow")!;
  check("shallow work keeps out of the focus window", shallow.start >= at(12), hhmm(shallow.start));
  const long = run({ candidates: cand(2, "deep", 90) });
  check(
    "a 90-minute box is followed by a 10-minute buffer",
    long.length === 2 && long[1].start.getTime() - long[0].end.getTime() >= 10 * 60_000,
    long.map((b) => `${hhmm(b.start)}-${hhmm(b.end)}`),
  );
}

// 3. No overlap with busy events, and the user's boxes stay where they are.
{
  const busy = [iv([9, 30], [10, 15]), iv([11, 0], [12, 30]), iv([15, 0], [15, 45])];
  const placed = [iv([10, 15], [11, 0]), iv([14, 0], [15, 0])];
  const out = run({ busy, placed, candidates: [...cand(3, "deep", 60), ...cand(6, "shallow", 30)] });
  check("never overlaps a busy event", out.every((b) => busy.every((e) => !overlaps(b, e))), out.map((b) => hhmm(b.start)));
  check("never overlaps a box you placed", out.every((b) => placed.every((p) => !overlaps(b, p))));
  check("drafts don't overlap each other", out.every((a, i) => out.every((b, j) => i === j || !overlaps(a, b))));
  check("every draft sits on the 15-minute grid", out.every((b) => b.start.getMinutes() % 15 === 0));
}

// 4. Inbox and Admin: hard, and capped at 30 minutes.
{
  const out = run({ candidates: [...cand(1, "admin", 60), ...cand(1, "inbox", 45)] });
  check(
    "Inbox and Admin boxes are hard and at most 30 minutes",
    out.length === 2 && out.every((b) => b.endMode === "hard" && b.end.getTime() - b.start.getTime() === 30 * 60_000),
    out,
  );
  check("other boxes are soft", run({ candidates: cand(1, "deep") })[0]?.endMode === "soft");
}

// 5. Today: nothing before now; after the shutdown, nothing at all.
{
  const out = run({ now: at(13, 5), candidates: cand(2, "deep") });
  check("on today, nothing is drafted before now", out.length === 2 && out.every((b) => b.start >= at(13, 15)), out.map((b) => hhmm(b.start)));
  check("after the work shutdown nothing is drafted", run({ now: at(18, 30), candidates: cand(2, "shallow") }).length === 0);
  check("a day off (Saturday) gets no drafts", run({ day: new Date(2026, 10, 7), now: new Date(2026, 10, 7, 7), candidates: cand(2, "shallow") }).length === 0);
}

// 6. Order is kept: the first candidates get the first slots.
{
  const out = run({ candidates: cand(3, "shallow", 60) });
  check("candidates are placed in the order given", out.map((b) => b.ref).join() === "task:shallow0,task:shallow1,task:shallow2");
}

// 7. A full day: an already-full window drafts nothing.
{
  const placed = [iv([9, 0], [18, 0])];
  check("a full day drafts nothing", run({ placed, candidates: cand(3, "shallow") }).length === 0);
}

// 8. firstSlot — the "+" buttons: the earliest free grid slot that fits.
{
  const taken = [iv([9, 0], [10, 0]), iv([10, 15], [11, 0])];
  const s = firstSlot(30, at(9, 5), at(18), taken);
  check("firstSlot skips a gap too small and lands on the grid", !!s && hhmm(s.start) === "11:00", s && hhmm(s.start));
  check("firstSlot returns null when nothing fits", firstSlot(60, at(9), at(10), taken) === null);
}

// 9. The timeline layout: buffers vs unboxed time, and lanes for clashes.
{
  const taken = [iv([9, 0], [10, 0]), iv([10, 15], [11, 0]), iv([11, 2], [12, 0])];
  const open = openTime(taken, at(9), at(14));
  check(
    "a 15m gap is a buffer, 2h is unboxed, a 2m sliver is dropped",
    open.map((g) => `${g.kind}:${g.minutes}`).join() === "buffer:15,unboxed:120",
    open.map((g) => `${g.kind}:${g.minutes}`),
  );
  const t = (h: number, m = 0) => at(h, m).getTime();
  const l = lanes([
    { start: t(9), end: t(10) },
    { start: t(9, 30), end: t(10, 30) },
    { start: t(10), end: t(11) },
    { start: t(13), end: t(14) },
  ]);
  check(
    "clashing blocks share lanes; a lone block gets the whole column",
    l.map((x) => `${x.lane}/${x.of}`).join() === "0/2,1/2,0/2,0/1",
    l,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
