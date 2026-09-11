/**
 * The "Ask" engine — cited Q&A strictly over the user's own indexed corpus
 * (notes, knowledge, Obsidian vault, ideas, tasks, files, and Notion when
 * connected). Retrieval is hybrid:
 *   1. Entity-aware: if the question names a known project, pull EVERYTHING
 *      directly linked to it (tasks, notes, files, goal/health, open
 *      attention) — complete and authoritative, not just similar-sounding.
 *   2. Semantic: the existing embedding search, for anything relevant that
 *      isn't formally linked (e.g. a vault note that mentions it in passing).
 * Synthesis is an Ollama-first model that must cite sources inline as [n].
 * Worker-safe (no next/cache).
 */
import { and, eq } from "drizzle-orm";
import { resolveRoute } from "@/core/ai/routing";
import { searchEverything, RELATED_MAX_DISTANCE } from "@/core/embeddings";
import { db } from "@/core/db/client";
import { projectFiles, projects } from "@/modules/projects/schema";
import { tasks } from "@/modules/tasks/schema";
import { filedUnder, notes } from "@/modules/notes/schema";
import { attentionItems } from "@/modules/today/schema";
import type { AskSource } from "./schema";
import { getSetting } from "@/core/app-settings";
import { verifyExternalLinks } from "./links";
import { webSearchSources } from "./websearch";
export type { AskSource } from "./schema";

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
  model: string;
}

// Per-block item caps — a safety net against a huge project blowing the
// prompt budget, not a real limit at today's data scale.
const MAX_TASKS = 40;
const MAX_NOTES = 15;
const MAX_FILES = 8;
const MAX_ATTENTION = 15;

/**
 * If the question names a known project (by a plain substring match — these
 * are distinctive proper names, not common words), pull a complete dossier of
 * everything linked to it via projectRef/projectId. This is what makes "get
 * me everything on X" work: a direct, complete pull beats top-K similarity
 * search, which only surfaces vaguely-related text and misses most of what's
 * actually tagged to the project.
 */
async function buildProjectDossier(
  query: string,
): Promise<{ sources: AskSource[]; seen: Set<string>; matchedNames: string[] }> {
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      goal: projects.goal,
      nextAction: projects.nextAction,
      health: projects.health,
      healthReason: projects.healthReason,
      status: projects.status,
    })
    .from(projects);

  const q = query.toLowerCase();
  // Guard on length so short/common project names can't false-positive-match
  // unrelated questions.
  const matched = allProjects.filter(
    (p) => p.name.length >= 4 && q.includes(p.name.toLowerCase()),
  );

  const sources: AskSource[] = [];
  const seen = new Set<string>(); // "kind:id" — dedupes against semantic hits later

  for (const p of matched) {
    const ref = `projects:${p.id}`;

    const overview = [
      `Project: ${p.name}`,
      `Status: ${p.status}`,
      p.description ? `Description: ${p.description}` : null,
      p.goal ? `Goal: ${p.goal}` : null,
      p.nextAction ? `Next action: ${p.nextAction}` : null,
      p.health ? `Health: ${p.health}${p.healthReason ? " — " + p.healthReason : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    sources.push({ n: 0, kind: "project", title: p.name, href: `/m/projects/${p.id}`, snippet: overview });

    const [projTasks, projNotes, projFiles, projAttention] = await Promise.all([
      db
        .select({ title: tasks.title, status: tasks.status, notes: tasks.notes })
        .from(tasks)
        .where(eq(tasks.projectRef, ref))
        .limit(MAX_TASKS),
      db
        .select({ id: notes.id, title: notes.title, body: notes.body })
        .from(notes)
        .where(filedUnder(p.id))
        .limit(MAX_NOTES),
      db
        .select({ id: projectFiles.id, filename: projectFiles.filename, extractedText: projectFiles.extractedText })
        .from(projectFiles)
        .where(and(eq(projectFiles.projectId, p.id), eq(projectFiles.status, "ready")))
        .limit(MAX_FILES),
      db
        .select({ title: attentionItems.title, body: attentionItems.body, type: attentionItems.type })
        .from(attentionItems)
        .where(and(eq(attentionItems.projectRef, ref), eq(attentionItems.status, "open")))
        .limit(MAX_ATTENTION),
    ]);

    if (projTasks.length) {
      const text = projTasks
        .map((t) => `- [${t.status}] ${t.title}${t.notes ? ": " + t.notes.slice(0, 200) : ""}`)
        .join("\n");
      sources.push({
        n: 0,
        kind: "task",
        title: `${p.name} — tasks (${projTasks.length})`,
        href: "/m/tasks",
        snippet: text.slice(0, 3500),
      });
    }
    for (const n of projNotes) {
      sources.push({ n: 0, kind: "note", title: n.title, href: `/m/notes/${n.id}`, snippet: (n.body ?? "").slice(0, 2500) });
      seen.add(`note:${n.id}`);
    }
    for (const f of projFiles) {
      sources.push({
        n: 0,
        kind: "file",
        title: f.filename,
        href: `/api/projects/files/${f.id}`,
        snippet: (f.extractedText ?? "").slice(0, 3000),
      });
      seen.add(`file:${f.id}`);
    }
    if (projAttention.length) {
      const text = projAttention
        .map((a) => `- (${a.type}) ${a.title}${a.body ? ": " + a.body.slice(0, 200) : ""}`)
        .join("\n");
      sources.push({
        n: 0,
        kind: "attention",
        title: `${p.name} — needs you (${projAttention.length})`,
        href: `/m/projects/${p.id}`,
        snippet: text.slice(0, 1500),
      });
    }
  }

  return { sources, seen, matchedNames: matched.map((p) => p.name) };
}

export async function answerQuestion(query: string): Promise<AskAnswer> {
  const q = query.trim();
  if (!q) return { answer: "", sources: [], model: "" };

  // Kick web enrichment off in parallel with local retrieval — it only needs
  // the question. Discarded below if the corpus turns up nothing (we never
  // answer from the web alone; it enriches the user's own data, never replaces
  // it). Gated by the `ask_web_search` toggle (default on) and a configured
  // SearXNG endpoint. Fail-open: any search/fetch trouble just yields none.
  const webOn = (await getSetting("ask_web_search").catch(() => null)) !== "off";
  const webPromise = webOn
    ? webSearchSources(q, { max: 5 }).catch(() => [] as AskSource[])
    : Promise.resolve([] as AskSource[]);

  const { sources: dossier, seen, matchedNames } = await buildProjectDossier(q);

  // Open the relevant "drawer": assess which area of development the question is
  // about (local model), so same-area items (mail, events, telegram…) rank ahead
  // of equally-similar off-topic ones. Best-effort — null just means no boost.
  const { assessQueryArea } = await import("@/core/area-classify");
  const area = await assessQueryArea(q).catch(() => null);

  // The dossier already carries the bulk for an entity-specific question;
  // fewer semantic slots are needed alongside it.
  const raw = await searchEverything(q, dossier.length > 0 ? 6 : 10, { area });
  const names = matchedNames.map((n) => n.toLowerCase());
  const hits = raw.filter((h) => {
    if (seen.has(`${h.kind}:${h.id}`)) return false; // already in the dossier
    // Drop weak-similarity noise everywhere (codebase-calibrated: >0.55 is
    // vocabulary overlap, not real relevance).
    if (h.distance > RELATED_MAX_DISTANCE) return false;
    // When answering about specific project(s), a semantic extra only earns a
    // slot if it actually mentions one of them — otherwise it's just
    // topically-adjacent clutter (e.g. a generic "Websites" vault note that
    // shares words with the project but says nothing about it).
    if (names.length > 0) {
      const hay = `${h.title} ${h.snippet ?? ""}`.toLowerCase();
      return names.some((n) => hay.includes(n));
    }
    return true;
  });

  const ownData = [...dossier, ...hits];
  if (ownData.length === 0) {
    return {
      answer:
        "I couldn't find anything in your saved data (notes, knowledge, vault, ideas, tasks, files, mail, calendar, people, Telegram, past answers…) about that.",
      sources: [],
      model: "",
    };
  }

  // The corpus is the backbone; web results (if any) are appended after it as
  // authoritative, current enrichment — already filtered + page-fetched.
  const web = await webPromise;
  const numbered = [...ownData, ...web].map((h, i) => ({ ...h, n: i + 1 }));
  const context = numbered
    .map((h) => `[${h.n}] (${h.kind}) ${h.title}\n${h.snippet ?? ""}`)
    .join("\n\n");

  const ownCount = ownData.length;
  const route = await resolveRoute("ask");
  const material = [
    `QUESTION: ${q}`,
    "",
    dossier.length > 0
      ? `SOURCES 1-${dossier.length} are a COMPLETE, authoritative pull of everything directly linked to the project(s) named in the question — every task, note, file, and open item, not merely similar text. Treat them as ground truth and use them fully; don't hedge or say details are missing if they're present in these sources. Sources after that are additional context found by similarity.`
      : "SOURCES (from the user's own saved data):",
    context,
    "",
    web.length > 0
      ? `SOURCES ${ownCount + 1}-${ownCount + web.length} (kind "web") are CURRENT, AUTHORITATIVE pages fetched from the live web to enrich the answer. Use them for up-to-date, professional context and cite them inline as [n] like any other source, and link to them with markdown \`[label](their url)\`. But sources 1-${ownCount} — the user's own data — remain the source of truth; the web sources support and enrich, they don't override it.`
      : null,
    web.length > 0 ? "" : null,
    `Answer the question using these sources for the substance, and cite them inline as [1], [2], etc. Sources 1-${ownCount} are the user's own data and are the backbone of the answer; don't invent facts beyond what the sources support. If they don't actually answer it, say so plainly rather than guessing. Be thorough when the sources are a complete project dossier — surface everything relevant, not just one line.`,
    "EXTERNAL LINKS — strict: only ever link to one of the provided \"web\" sources above (use its EXACT url from the source list). NEVER write a URL from memory, and never guess or construct a link — invented links are almost always dead, parked (domain-for-sale), or off-topic, and are automatically fetched-and-checked, so a bad one is stripped and just wastes the reader's trust. If none of the provided web sources fit, add NO link at all — a plain, unlinked mention is better than a broken one. The [n] citations to the user's own data remain the backbone.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  let answer = "";
  for await (const ev of route.provider.run({
    system:
      "You are the Ask engine of apOS, the user's Agentic Personalized Operating System. Write in a precise, professional register. The SUBSTANCE of your answer comes strictly from the user's own saved data — notes, knowledge, vault, ideas, tasks, files, mail, calendar, people, Telegram, and past answers — never invented facts — and you cite those sources inline as [n]. For external links, use ONLY the exact URLs of the provided \"web\" sources; NEVER invent, guess, or reconstruct a URL from memory (they are fetched and verified, so a fabricated link is stripped). If the provided sources don't answer the question, say so.",
    messages: [{ role: "user", content: material }],
    tools: [],
    toolCtx: { db },
    model: route.model,
    maxTurns: 1,
    track: { source: "ask", label: "ask" },
    signal: AbortSignal.timeout(90_000),
  })) {
    if (ev.type === "text") answer = ev.text;
    if (ev.type === "done") answer = ev.text || answer;
    if (ev.type === "error") throw new Error(ev.message);
  }

  // Any external link the model emitted is FETCHED and checked — parked/for-sale
  // /404 pages by content signature, then a local-LLM judge for real on-topic
  // usefulness against the question. Survivors stay links; the rest demote to
  // plain text. The [n] citations (no `(url)`) are untouched.
  const cleaned = await verifyExternalLinks(answer.trim(), q);

  return {
    answer: cleaned,
    sources: numbered.map((h) => ({
      n: h.n,
      kind: h.kind,
      title: h.title,
      href: h.href,
      snippet: h.snippet,
    })),
    model: `${route.providerId}/${route.model}`,
  };
}
