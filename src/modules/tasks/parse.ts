import type { TaskPriority, TaskStatus } from "./schema";

/**
 * Quick-create grammar — type the title, sprinkle tokens anywhere:
 *
 *   !urgent !high !med !low   (or !u !h !m !l)   priority
 *   #label                                        labels (repeatable)
 *   @today @tomorrow @fri @+3d @2026-10-05 @10-05 due date
 *   ~3                                            estimate (points)
 *   +ETHOS                                        project, by key
 *   >backlog >todo >doing >review                 state
 *
 * Plain-word aliases also work: p0–p3 (urgent → low), "due fri", "3pts" / "3 pts".
 *
 * "Fix login redirect !h #auth @fri ~2" → title "Fix login redirect", high,
 * label auth, due Friday, 2 points. Pure — no I/O — so it runs in the browser.
 */
export interface ParsedQuick {
  title: string;
  priority?: TaskPriority;
  labels: string[];
  dueAt?: Date;
  estimate?: number;
  projectKey?: string;
  status?: TaskStatus;
}

const PRIORITIES: Record<string, TaskPriority> = {
  urgent: "urgent", u: "urgent", high: "high", h: "high",
  med: "medium", medium: "medium", m: "medium", low: "low", l: "low",
};
const P_LEVELS: TaskPriority[] = ["urgent", "high", "medium", "low"];
const STATES: Record<string, TaskStatus> = {
  backlog: "backlog", todo: "todo", doing: "doing", wip: "doing", review: "review",
};
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(18, 0, 0, 0);
  return x;
}

export function parseDue(token: string, now = new Date()): Date | undefined {
  const t = token.toLowerCase();
  const base = new Date(now);
  if (t === "today") return endOfDay(base);
  if (t === "tomorrow" || t === "tmr") {
    base.setDate(base.getDate() + 1);
    return endOfDay(base);
  }
  const rel = t.match(/^\+(\d{1,3})([dw])$/);
  if (rel) {
    base.setDate(base.getDate() + Number(rel[1]) * (rel[2] === "w" ? 7 : 1));
    return endOfDay(base);
  }
  const dow = DAYS.indexOf(t.slice(0, 3));
  if (dow >= 0 && /^[a-z]+$/.test(t)) {
    const diff = (dow - base.getDay() + 7) % 7 || 7; // next occurrence, never today
    base.setDate(base.getDate() + diff);
    return endOfDay(base);
  }
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return endOfDay(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const md = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    let d = new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    if (d < new Date(base.getFullYear(), base.getMonth(), base.getDate())) d = new Date(base.getFullYear() + 1, Number(md[1]) - 1, Number(md[2]));
    return endOfDay(d);
  }
  return undefined;
}

export function parseQuick(input: string, now = new Date()): ParsedQuick {
  const out: ParsedQuick = { title: "", labels: [] };
  const rest: string[] = [];
  const words = input.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const head = word[0];
    const body = word.slice(1);
    const lower = word.toLowerCase();
    const next = words[i + 1]?.toLowerCase();
    if (head === "!" && PRIORITIES[body.toLowerCase()]) out.priority = PRIORITIES[body.toLowerCase()];
    else if (/^p[0-3]$/.test(lower)) out.priority = P_LEVELS[Number(lower[1])];
    else if (head === "#" && /^\p{L}[\p{L}\p{N}_-]*$/u.test(body)) out.labels.push(body.toLowerCase());
    else if (head === "@" && body && parseDue(body, now)) out.dueAt = parseDue(body, now);
    else if (lower === "due" && next && parseDue(next, now)) {
      out.dueAt = parseDue(next, now);
      i++;
    } else if (head === "~" && /^\d{1,2}$/.test(body)) out.estimate = Number(body);
    else if (/^\d{1,2}pts?$/.test(lower)) out.estimate = parseInt(lower, 10);
    else if (/^\d{1,2}$/.test(word) && (next === "pts" || next === "pt")) {
      out.estimate = Number(word);
      i++;
    } else if (head === "+" && /^[A-Za-z]{2,5}$/.test(body)) out.projectKey = body.toUpperCase();
    else if (head === ">" && STATES[body.toLowerCase()]) out.status = STATES[body.toLowerCase()];
    else rest.push(word);
  }
  out.title = rest.join(" ").trim();
  out.labels = [...new Set(out.labels)];
  return out;
}
