/**
 * Throwaway DEMO seed — realistic FAKE data for screenshots / demos.
 * Run against a throwaway DB only:
 *   DATABASE_URL=postgres://aios:aios@localhost:5544/aios_demo npx tsx scripts/seed-demo.mts
 *
 * Uses raw db.insert (tsx-safe) per the schemas, then syncSearchIndex + sweepEmbeddings
 * so unified search works on the demo corpus. All data is invented — no real PII.
 */
import { randomUUID } from "node:crypto";
import { db, sql } from "@/core/db/client";
import { tasks } from "@/modules/tasks/schema";
import { projects, projectRefOf } from "@/modules/projects/schema";
import { ideas } from "@/modules/ideas/schema";
import { knowledgeItems } from "@/modules/knowledge/schema";
import { agents, agentRuns } from "@/core/db/schema/agents";
import { attentionItems } from "@/modules/today/schema";
import { inboxItems } from "@/modules/inbox/schema";
import { calendarEvents } from "@/modules/calendar/schema";

const now = new Date();
const h = (n: number) => new Date(now.getTime() + n * 3600_000);
const d = (n: number) => new Date(now.getTime() + n * 86400_000);
const todayAt = (hour: number, min = 0) => {
  const x = new Date(now);
  x.setHours(hour, min, 0, 0);
  return x;
};

async function main() {
  console.log("seeding demo data →", process.env.DATABASE_URL);

  // ── Projects ────────────────────────────────────────────────────────────
  const pLumen = randomUUID();
  const pApi = randomUUID();
  const pSite = randomUUID();
  const pContent = randomUUID();
  await db.insert(projects).values([
    { id: pLumen, name: "Lumen — iOS App Launch", category: "Product", kind: "project",
      status: "active", health: "at_risk", healthReason: "TestFlight feedback piling up before submission",
      goal: "Ship Lumen v1.0 to the App Store", nextAction: "Finalize the onboarding flow copy",
      description: "A calm, offline-first habit tracker for iOS.", updatedAt: h(-3) },
    { id: pApi, name: "API v2 Migration", category: "Engineering", kind: "project",
      status: "active", health: "on_track",
      goal: "Move all clients onto the v2 auth + pagination", nextAction: "Cut over the auth endpoints behind a flag",
      description: "Versioned REST → typed, cursor-paginated v2.", updatedAt: h(-26) },
    { id: pSite, name: "Personal Site Redesign", category: "Marketing", kind: "project",
      status: "active", health: "stalled", healthReason: "No decision on the hero layout for 3 weeks",
      goal: "Relaunch the portfolio with the writing archive", nextAction: "Pick one of the 3 hero mockups",
      description: "Astro + MDX rebuild of the personal site.", updatedAt: d(-6) },
    { id: pContent, name: "Content Engine", category: "Growth", kind: "area",
      status: "active", goal: "Publish one substantial post every week",
      nextAction: "Draft: 'Local-first AI, one year in'", description: "The always-on writing + distribution area.",
      updatedAt: h(-49) },
  ]);

  // ── Tasks ───────────────────────────────────────────────────────────────
  const T = (title: string, project: string | null, status: "todo" | "doing" | "done",
    priority: "low" | "medium" | "high", dueAt: Date | null, done?: Date, notes?: string) => ({
    id: randomUUID(), title, notes: notes ?? null, status, priority, dueAt,
    projectRef: project ? projectRefOf(project) : null, featureRef: null,
    createdAt: d(-7), completedAt: done ?? null,
  });
  await db.insert(tasks).values([
    T("Finalize onboarding flow copy", pLumen, "doing", "high", todayAt(17), undefined,
      "3 screens; keep it to one sentence each."),
    T("Fix crash on empty habit list", pLumen, "todo", "high", todayAt(19)),
    T("Record App Store preview video", pLumen, "todo", "medium", d(2)),
    T("Cut over auth endpoints behind a flag", pApi, "doing", "high", todayAt(15)),
    T("Write migration guide for v1 clients", pApi, "todo", "medium", d(3)),
    T("Deprecate /v1/login (410 + notice)", pApi, "todo", "low", d(9)),
    T("Pick hero layout (A/B/C)", pSite, "todo", "medium", todayAt(12)),
    T("Draft 'Local-first AI, one year in'", pContent, "todo", "high", d(1)),
    T("Reply to TestFlight feedback thread", pLumen, "done", "medium", null, h(-4)),
    T("Set up cursor pagination helper", pApi, "done", "high", null, h(-28)),
    T("Export old blog posts to MDX", pSite, "done", "low", null, d(-2)),
    T("Book the launch-week newsletter slot", pContent, "done", "medium", null, d(-1)),
  ]);

  // ── Ideas (with full AI reality-check) ────────────────────────────────────
  const idea = (title: string, category: string, stage: string,
    verdict: "pursue" | "explore" | "park", score: number, summary: string,
    strengths: string[], risks: string[], validationSteps: string[], projectRef?: string) => ({
    id: randomUUID(), title, category, stage, notes: null,
    analysisStatus: "ready" as const,
    analysis: { verdict, score, summary, strengths, risks, validationSteps },
    analysisError: null, projectRef: projectRef ?? null, createdAt: d(-5), updatedAt: d(-4),
  });
  await db.insert(ideas).values([
    idea("Weekly AI digest for indie founders", "product", "validated", "pursue", 8,
      "A focused, no-hype weekly on shipping AI features solo. Clear audience, low build cost, compounding SEO.",
      ["Sharp, underserved audience", "Cheap to pilot with your own writing", "Feeds the Content Engine"],
      ["Consistency is the real cost", "Crowded newsletter space"],
      ["Ship 3 issues to a waitlist", "Measure open-rate vs a 200-subscriber goal"]),
    idea("Voice capture → triaged tasks", "feature", "exploring", "pursue", 7,
      "Speak a thought, apOS transcribes and files it into the right module. Natural fit for the Inbox fast-path.",
      ["Removes the highest-friction capture step", "Reuses the existing triage pipeline"],
      ["On-device transcription quality on older Macs", "Scope creep into a full assistant"],
      ["Prototype with whisper.cpp on one hotkey", "Dogfood for a week, count captures"]),
    idea("Offline-first note sync across devices", "product", "exploring", "explore", 6,
      "CRDT-based sync so notes work on a plane and merge later. Strong with the local-first story, but heavy.",
      ["On-brand with local-first", "High user value"],
      ["CRDT plumbing is a big lift", "Not the current bottleneck"],
      ["Spike yjs on the notes table", "Timebox to 2 days before committing"]),
    idea("Paid template marketplace", "business", "parked", "park", 4,
      "Sell module/agent templates. Monetization is tempting but premature — distribution isn't there yet.",
      ["Direct revenue", "Showcases the plugin architecture"],
      ["No audience to sell to yet", "Support + payments overhead", "Distracts from v1 launch"],
      ["Revisit after 1k active users"]),
  ] as (typeof ideas.$inferInsert)[]);

  // ── Knowledge (ready, enriched) ───────────────────────────────────────────
  const know = (input: string, kind: string, title: string, url: string | null,
    insight: { summary: string; keyIdeas: string[]; useCases: string[]; quotes: string[]; tags: string[]; relevance: string }) => ({
    id: randomUUID(), input, kind, url, title, note: null, status: "ready" as const,
    statusDetail: null, raw: null, insight, createdAt: d(-3), updatedAt: d(-3),
  });
  await db.insert(knowledgeItems).values([
    know("https://github.com/example/local-first-toolkit", "github",
      "local-first-toolkit — CRDT building blocks", "https://github.com/example/local-first-toolkit",
      { summary: "A batteries-included toolkit for building local-first apps with CRDT sync and conflict-free merges.",
        keyIdeas: ["Sync is a library, not a backend", "Conflict-free merges via CRDTs", "Works offline by default"],
        useCases: ["The offline note-sync idea", "Making apOS multi-device"], quotes: [], tags: ["local-first", "crdt", "sync"], relevance: "high" }),
    know("https://youtube.com/watch?v=demo", "youtube",
      "Talk: Shipping AI features without a cloud bill", "https://youtube.com/watch?v=demo",
      { summary: "Case study on running production AI features entirely on local models to keep costs and latency down.",
        keyIdeas: ["Local models cover ~80% of tasks", "Route only the hard 20% to a paid model", "Cache aggressively"],
        useCases: ["Justifies the Ollama-first routing", "Digest newsletter material"], quotes: ["\"The cheapest token is the one you never send.\""], tags: ["local-ai", "cost", "routing"], relevance: "high" }),
    know("The best interface is the one that disappears — capture first, organize never.", "quote",
      "On frictionless capture", null,
      { summary: "A design principle: minimize the cost of getting a thought out of your head; let AI do the filing.",
        keyIdeas: ["Capture cost must approach zero", "Organization is a machine job"],
        useCases: ["Framing for the Inbox fast-path", "Voice-capture idea"], quotes: ["The best interface is the one that disappears."], tags: ["design", "capture", "philosophy"], relevance: "medium" }),
    know("https://example.com/astro-content-collections", "link",
      "Astro Content Collections — typed MDX", "https://example.com/astro-content-collections",
      { summary: "How to model a blog/writing archive as typed content collections in Astro with schema validation.",
        keyIdeas: ["Frontmatter as a typed schema", "Build-time validation of content"],
        useCases: ["The site redesign's writing archive"], quotes: [], tags: ["astro", "mdx", "content"], relevance: "medium" }),
  ] as (typeof knowledgeItems.$inferInsert)[]);

  // ── Agents (+ succeeded runs with transcripts) ────────────────────────────
  const aDigest = randomUUID(), aWatch = randomUUID(), aTriage = randomUUID();
  await db.insert(agents).values([
    { id: aDigest, name: "Daily Standup Digest", description: "Summarizes what moved yesterday and what needs you today.",
      prompt: "Summarize task/project changes in the last 24h and surface the top 3 things that need attention today.",
      tools: ["tasks.list", "projects.list", "today.needsYou"], schedule: "0 8 * * *", enabled: true,
      provider: "ollama", model: "qwen3-coder:30b", turnBudget: 8, createdAt: d(-20) },
    { id: aWatch, name: "Competitor Watch", description: "Scans a few sources for moves worth knowing about.",
      prompt: "Check the configured sources for notable competitor releases and file anything relevant to Knowledge.",
      tools: ["knowledge.capture", "search.web"], schedule: "0 7 * * 1", enabled: true,
      provider: "ollama", model: "qwen3:8b", turnBudget: 6, createdAt: d(-18) },
    { id: aTriage, name: "Inbox Triage", description: "Files captured items into the right module.",
      prompt: "For each new inbox item, classify and route it to tasks/notes/ideas/knowledge with a one-line summary.",
      tools: ["inbox.list", "tasks.create", "ideas.create"], schedule: null, enabled: true,
      provider: "ollama", model: "qwen3:8b", turnBudget: 5, createdAt: d(-14) },
  ]);
  const run = (agentId: string, startedAt: Date, result: string, transcript: unknown[], tIn = 1200, tOut = 480) => ({
    id: randomUUID(), agentId, status: "succeeded" as const, trigger: "cron" as const,
    startedAt, finishedAt: new Date(startedAt.getTime() + 42_000), heartbeatAt: new Date(startedAt.getTime() + 42_000),
    transcript, result, error: null, tokensIn: tIn, tokensOut: tOut, createdAt: startedAt,
  });
  await db.insert(agentRuns).values([
    run(aDigest, h(-25),
      "3 tasks completed yesterday. Today: finalize onboarding copy (due 5pm), cut over auth endpoints, reply to TestFlight.",
      [
        { type: "tool_call", name: "tasks.list", input: { since: "24h" } },
        { type: "tool_result", name: "tasks.list", result: { completed: 3, open: 9 } },
        { type: "tool_call", name: "today.needsYou", input: {} },
        { type: "tool_result", name: "today.needsYou", result: { count: 4 } },
        { type: "usage", inputTokens: 1200, outputTokens: 480 },
        { type: "done", text: "3 tasks completed yesterday. Top today: onboarding copy, auth cutover, TestFlight reply." },
      ]),
    run(aDigest, h(-49),
      "Quiet day: 1 task done. Lumen is at-risk — TestFlight feedback needs a reply.",
      [
        { type: "tool_call", name: "projects.list", input: { status: "active" } },
        { type: "tool_result", name: "projects.list", result: { atRisk: ["Lumen — iOS App Launch"] } },
        { type: "usage", inputTokens: 900, outputTokens: 300 },
        { type: "done", text: "1 task done. Flagging Lumen (at-risk): reply to TestFlight feedback." },
      ], 900, 300),
    run(aWatch, d(-2),
      "Filed 1 item to Knowledge: a talk on shipping AI features without a cloud bill.",
      [
        { type: "tool_call", name: "search.web", input: { q: "local AI product launch" } },
        { type: "tool_result", name: "search.web", result: { hits: 5 } },
        { type: "tool_call", name: "knowledge.capture", input: { url: "https://youtube.com/watch?v=demo" } },
        { type: "tool_result", name: "knowledge.capture", result: { status: "captured" } },
        { type: "usage", inputTokens: 1500, outputTokens: 220 },
        { type: "done", text: "Filed 1 relevant item to Knowledge." },
      ], 1500, 220),
  ]);

  // ── Attention items (the "Needs you" hero card) ───────────────────────────
  await db.insert(attentionItems).values([
    { id: randomUUID(), type: "review", status: "open", urgency: 90, title: "Review: onboarding copy for Lumen",
      body: "Draft is ready on the 3 onboarding screens — approve or tweak before the build.", projectRef: projectRefOf(pLumen),
      href: null, dedupeKey: null, createdAt: h(-2) },
    { id: randomUUID(), type: "approve", status: "open", urgency: 80, title: "Approve: deprecate /v1/login",
      body: "Sending a 410 with a migration notice to remaining v1 clients. OK to proceed?", projectRef: projectRefOf(pApi),
      href: null, dedupeKey: null, createdAt: h(-5) },
    { id: randomUUID(), type: "question", status: "open", urgency: 60, title: "Which hero layout for the site?",
      body: "Three mockups are waiting — A (bold), B (minimal), C (editorial). This has been stalled 3 weeks.", projectRef: projectRefOf(pSite),
      href: null, dedupeKey: null, createdAt: d(-1) },
    { id: randomUUID(), type: "do", status: "open", urgency: 50, title: "Record the App Store preview video",
      body: "30-second capture of the core loop. Needed for submission.", projectRef: projectRefOf(pLumen),
      href: null, dedupeKey: null, createdAt: h(-8) },
  ]);

  // ── Calendar (today) ──────────────────────────────────────────────────────
  await db.insert(calendarEvents).values([
    { id: randomUUID(), title: "Solo standup + plan the day", startAt: todayAt(9), endAt: todayAt(9, 20),
      allDay: false, source: "local", location: null, notes: null, meetingUrl: null },
    { id: randomUUID(), title: "Design review — onboarding screens", startAt: todayAt(13), endAt: todayAt(13, 45),
      allDay: false, source: "local", location: null, notes: null, meetingUrl: "https://meet.example.com/lumen" },
    { id: randomUUID(), title: "Deep work — auth cutover", startAt: todayAt(15), endAt: todayAt(17),
      allDay: false, source: "local", location: null, notes: null, meetingUrl: null },
  ]);

  // ── Inbox (triaged) ───────────────────────────────────────────────────────
  await db.insert(inboxItems).values([
    { id: randomUUID(), input: "idea: let agents post their digest to a private RSS feed", status: "triaged",
      triage: { summary: "Feature idea — agent digests as a private RSS feed.", route: { kind: "idea", label: "Filed to Ideas", href: "/m/ideas" }, verified: true },
      createdAt: h(-6) },
    { id: randomUUID(), input: "https://example.com/astro-content-collections", status: "triaged",
      triage: { summary: "Reference for the site's typed writing archive.", route: { kind: "knowledge", label: "Saved to Knowledge", href: "/m/knowledge" }, verified: true },
      createdAt: h(-9) },
    { id: randomUUID(), input: "remember to rotate the TestFlight build before the weekend", status: "new",
      triage: null, createdAt: h(-1) },
  ] as (typeof inboxItems.$inferInsert)[]);

  // ── Make it all searchable ────────────────────────────────────────────────
  console.log("syncing search index…");
  const { syncSearchIndex } = await import("@/core/search-index");
  await syncSearchIndex();
  console.log("embedding (nomic-embed-text via Ollama)…");
  const { sweepEmbeddings } = await import("@/core/embeddings");
  await sweepEmbeddings();

  const counts = await sql`
    select 'projects' t, count(*) c from projects
    union all select 'tasks', count(*) from tasks
    union all select 'ideas', count(*) from ideas
    union all select 'knowledge', count(*) from knowledge_items
    union all select 'agents', count(*) from agents
    union all select 'agent_runs', count(*) from agent_runs
    union all select 'attention', count(*) from attention_items
    union all select 'calendar', count(*) from calendar_events
    union all select 'inbox', count(*) from inbox_items
    union all select 'search_index', count(*) from search_index`;
  console.log("seeded:", Object.fromEntries(counts.map((r) => [r.t, Number(r.c)])));
  await sql.end();
  console.log("✓ done");
}

main().catch((e) => { console.error(e); process.exit(1); });
