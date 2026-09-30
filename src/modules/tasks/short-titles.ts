/**
 * Short display titles for long work-item titles (imported ETHOS items run to
 * several sentences). The original `title` is never touched: the result goes to
 * `short_title`, stamped with `short_title_of = titleHash(title)` — the ledger.
 * A row is (re)done only when that stamp is missing or stale, so re-runs are
 * no-ops and an edited title is picked up on the next pass.
 *
 * Free and local: the first sentence when it already fits, otherwise one
 * qwen3:8b call per title through the local-inference queue.
 */
import { gt, sql as dsql } from "drizzle-orm";
import type { db as Db } from "@/core/db/client";
import { withLocalSlot } from "@/core/ai/local-queue";
import { withTrackedCall } from "@/core/ai/model-track";
import { tasks } from "./schema";
import { plainTitle, titleHash } from "./states";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const MODEL = "qwen3:8b";
/** Titles longer than this get a short title. */
const LONG = 100;
/** A short title must fit in this. */
const MAX = 90;

/** "#SLUG —", "S22.1 —", "ETHOS-12:" … — kept verbatim at the front. */
const PREFIX = /^((?:#[\w.-]+|[A-Z]{0,4}\d+(?:\.\d+)*|[A-Z]+-\d+)\s*[—–:-]\s*)/;

/** The **bold lead phrase** many imported titles open with — the author's own headline. */
function boldLead(raw: string): string | null {
  const m = raw.replace(PREFIX, "").match(/^\s*\*\*(.{8,}?)\*\*/);
  return m ? plainTitle(m[1]).replace(/\.$/, "") : null;
}

function firstSentence(plain: string): string | null {
  const m = plain.match(/^(.{12,}?[.!?])(?:\s|$)/);
  return m && m[1].length <= MAX ? m[1].replace(/\.$/, "") : null;
}

function wordCut(s: string): string {
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:—–-]+$/, "")}…`;
}

async function modelShorten(plain: string, budget: number): Promise<string | null> {
  const system =
    `You shorten work-item titles. Reply with ONLY the new title: one line, at most ${budget} characters, ` +
    "sentence case, same language, no quotes, no trailing period. Keep the concrete subject and the key " +
    "action; drop explanations, examples, dates and parentheses.";
  // Native /api/chat so thinking can be switched off (qwen3 otherwise reasons
  // for 10–20s on a one-line rewrite).
  const res = await withLocalSlot(() =>
    withTrackedCall("ollama", MODEL, { source: "job", label: "short titles" }, () =>
    fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: plain.slice(0, 600) },
        ],
        think: false,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(60_000),
    })),
  );
  if (!res.ok) throw new Error(`short-title model → HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const out = (data.message?.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  return out && out.length >= 8 ? out : null;
}

/** One title → its short form (prefix kept). Throws only when the model is unreachable. */
export async function shortenTitle(title: string): Promise<string> {
  const plain = plainTitle(title).replace(/\s+/g, " ");
  const prefix = plain.match(PREFIX)?.[1] ?? "";
  const body = plain.slice(prefix.length);
  const budget = Math.max(30, Math.min(70, MAX - prefix.length));
  const lead = boldLead(title);
  if (lead && lead.length <= budget) return prefix + lead;
  const fits = firstSentence(body);
  if (fits && fits.length <= budget) return prefix + fits;
  const short = await modelShorten(body, budget);
  // A model reply that's too long or empty falls back to a clean word cut.
  const core = short && prefix.length + short.length <= MAX ? short : wordCut(body);
  return wordCut(prefix + core.replace(PREFIX, ""));
}

/** Fill up to `batch` missing/stale short titles. Returns how many were written. */
export async function fillShortTitles(
  db: typeof Db,
  batch = 30,
  log: (m: string) => void = () => {},
): Promise<{ written: number; pending: number }> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, of: tasks.shortTitleOf })
    .from(tasks)
    .where(gt(dsql`length(${tasks.title})`, LONG));
  const todo = rows
    .filter((r) => r.of !== titleHash(r.title))
    // Open work first — that's what the board and lists show.
    .sort((a, b) => Number(a.status === "done" || a.status === "cancelled") - Number(b.status === "done" || b.status === "cancelled"));

  let written = 0;
  for (const r of todo.slice(0, batch)) {
    let short: string;
    try {
      short = await shortenTitle(r.title);
    } catch (e) {
      // Model down: leave the ledger alone so the next pass retries.
      log(`short titles: ${e instanceof Error ? e.message : String(e)} — stopping this pass`);
      break;
    }
    await db
      .update(tasks)
      .set({ shortTitle: short, shortTitleOf: titleHash(r.title) })
      // Only if the title didn't change while we were thinking.
      .where(dsql`${tasks.id} = ${r.id} and ${tasks.title} = ${r.title}`);
    written++;
  }
  return { written, pending: Math.max(0, todo.length - written) };
}
