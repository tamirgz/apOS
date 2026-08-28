# Agent reference

> Auto-generated from the agent templates by `scripts/gen-agent-docs.mts` — do not edit by hand.
> The same information renders live on each agent's page in the app.

Every agent follows the same shape: it **reads** a bounded set of inputs, **decides** per its instructions, **suggests / acts** through a few write tools, and **learns** from its own runs. It runs unattended on a schedule (free local model unless noted), and only writes when its task calls for it.

**How every agent learns.** Self-learning: after each run it reflects on what it did and, if there's something worth remembering, stores a one-line lesson scoped to itself in the shared 3-layer memory; at its next run it recalls its own past lessons and applies them. Persistent failures also feed the weekly distill that rewrites the shared operating rules injected into every agent run.

---

## Daily brief

_Every morning: your unified agenda (Google events, task deadlines, publish dates) plus open-task summary, pushed to the bell and Slack._

- **Module:** `calendar`
- **Schedule:** `0 7 * * *` (daily 07:00)
- **Model:** account default

**Reads (inputs it works from):**

- `calendar.agenda` — Get the user's unified agenda: calendar events (incl.
- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.

**Suggests / acts (outputs):**

- `notify.send` — Send the user a notification (bell feed + Slack if configured).

**Decides (its instructions):**

> Build my morning brief. Use calendar.agenda (days: 1) for today's schedule and tasks.list (status: todo) for open work. Compose one concise brief: schedule first, then the 3 most important tasks. Send it with notify.send (title 'Morning brief', level 'info'). Use ledger.mark with today's date as itemKey so a re-run the same day is a no-op after checking ledger.has first.

---

## Daily planner

_Every weekday morning: reads your calendar, due tasks and active projects, then proposes the day and raises the 1–2 things that matter as attention cards. Runs on a free local model._

- **Module:** `today`
- **Schedule:** `30 7 * * 1-5` (weekdays 07:30)
- **Model:** ollama · `qwen3-coder:30b`

**Reads (inputs it works from):**

- `projects.list` — List projects with their L2 cockpit rollup: status, goal, next action, resolved health + reason, open/done/overdue task counts, and days since last activity.
- `attention.list` — List currently-open attention items so you don't raise a duplicate, can reason about what's already surfaced, or close one you raised (each carries a `ref` for attention.resolve).
- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.
- `gmail.recent` — List recent emails (last 7 days, metadata only: from, subject, snippet, when, unread).
- `search.everything` — Semantic search across ALL the user's data — notes, knowledge base, tasks — by meaning, not just keywords.

**Suggests / acts (outputs):**

- `attention.raise` — Surface something that needs the user's attention as a card in the 'Needs you' queue.

**Decides (its instructions):**

> You are the user's chief-of-staff planning the day. Today's plan surface already shows their calendar and due tasks — your job is judgment, not repetition.
> 1. Use attention.list to see what's already surfaced (never duplicate), and projects.list for your active projects (names, health, next action) — so a card can anchor to the right project by its NAME. Project next-actions are handled elsewhere — derived from each project's real tasks, with the pulse writing an '[Advise] …' step when a project has none — so you do NOT set them here.
> 2. Raise at most 2–3 attention items for what genuinely needs the user today: a 'do' card for the single most important next step, and a 'notify' if something is slipping. To anchor a card to a project, pass its NAME to attention.raise (never an id). Use type 'do'/'notify'; reserve 'approve' for real side-effects (there are none here). Give each a dedupeKey like 'plan:<YYYY-MM-DD>:<slug>' so a re-run today is a no-op.
> 3. Keep it minimal — a good chief of staff surfaces the vital few, not everything. Do not send notifications; the cards are the output.

---

## Follow-up tracker

_After your meetings, proposes the follow-ups worth doing — one card per person, into the 'Needs you' queue. Runs on a free local model._

- **Module:** `people`
- **Schedule:** `0 18 * * 1-5` (weekdays 18:00)
- **Model:** ollama · `qwen3-coder:30b`

**Reads (inputs it works from):**

- `people.recentMeetings` — List meetings that already happened in the last N days (default 3), with attendees and the meeting's actual notes/agenda.
- `people.list` — List the people you meet with (derived from calendar attendees): name, email, how many meetings, days since you last met, and open follow-up count.
- `people.get` — Read ONE person in full — their durable notes, email, meeting count, days since you last met, and their open follow-ups.
- `attention.list` — List currently-open attention items so you don't raise a duplicate, can reason about what's already surfaced, or close one you raised (each carries a `ref` for attention.resolve).
- `gmail.recent` — List recent emails (last 7 days, metadata only: from, subject, snippet, when, unread).

**Suggests / acts (outputs):**

- `followup.raise` — Raise a follow-up as a card in the 'Needs you' queue, anchored to a person.
- `people.setNotes` — Record a short durable note about a person (context, what they care about, open threads).

**Decides (its instructions):**

> You are the user's chief-of-staff handling post-meeting follow-ups. Surface only the follow-ups that genuinely matter — a good chief of staff is selective, and NEVER invents work.
> 1. Call people.recentMeetings (last 2 days) to see meetings that already happened, with attendees and the meeting's actual notes. Call attention.list to see what follow-ups are already open (never duplicate).
> 2. CRITICAL — a follow-up must be GROUNDED IN THE MEETING'S NOTES. Only consider meetings where hasNotes is true. SKIP every meeting where hasNotes is false: with no notes there is nothing to follow up on, and a title that is just participants' names (in any language) tells you nothing about what happened. Never guess or infer what a note-less meeting was about.
> 3. For a meeting that has notes, pick the key attendee and find their `ref` via people.list (match on email — each person comes back with a short ref like 'p2'). Raise ONE follow-up with followup.raise using that `ref` (never an id): type 'do' with a concrete step drawn ONLY from that meeting's notes. Never state a specific — a feature name, document, number, or deliverable — that does not literally appear in the notes. Quote or closely paraphrase the notes; do not embellish.
> 3a. If (and only if) the meeting notes reveal something durable worth remembering about that person, read their current note with people.get FIRST, then people.setNotes with the two MERGED — people.setNotes overwrites, so never blind-overwrite an existing note.
> 4. Do not send anything — the cards are the output. It is correct and expected to raise ZERO follow-ups when no recent meeting has notes. Aim for at most 3-4, only when the notes genuinely warrant it.

---

## Idea reviewer

_Weekly: reviews sparks and exploring ideas, picks the 1-2 most worth pushing forward, and nudges you via notification._

- **Module:** `ideas`
- **Schedule:** `0 9 * * 1` (Mon 09:00)
- **Model:** account default

**Reads (inputs it works from):**

- `ideas.list` — List the user's ideas, optionally by stage (spark | exploring | validated | parked).

**Suggests / acts (outputs):**

- `ideas.setStage` — Move an idea to a new stage (spark | exploring | validated | parked).
- `notify.send` — Send the user a notification (bell feed + Slack if configured).

**Decides (its instructions):**

> Review my idea pipeline with ideas.list (stages spark and exploring) — each idea comes back with a short `ref` (e.g. 'i2'). Considering my memory context (who I am, current focus), pick the 1-2 ideas most worth advancing this week and say why in one sentence each; flag any that should be parked. Move an idea's stage with ideas.setStage, identifying it by its `ref` (never an id). Send the conclusion with notify.send (title 'Idea review'). Use ledger.mark with the ISO week so a same-week re-run is a no-op after checking ledger.has.

---

## Investment insight

_Reviews your iSentry portfolio (positions + recent transactions) and writes a concise, honest, DESCRIPTIVE read — concentration, drift, notable moves — into memory so insight accrues over time. Free local model. Not financial advice._

- **Module:** `investments`
- **Schedule:** manual only
- **Model:** ollama · `qwen3-coder:30b`

**Reads (inputs it works from):**

- `portfolio.summary` — One-line roll-up across all live holdings (USD): number of positions, total market value, cost basis, unrealized & realized P&L, dividends.
- `portfolio.positions` — Current holdings from iSentry: symbol, quantity, avg cost, current price, market value, unrealized/realized P&L, dividends, currency.
- `portfolio.performance` — Daily portfolio value time series (total value in USD + ILS, and P&L) for the last N days, summed across your portfolios.
- `portfolio.transactions` — Recent portfolio transactions (buys/sells/dividends) from iSentry, newest first: symbol, type, quantity, price, total, currency, date.
- `portfolio.byStrategy` — Measure the performance of trades tagged with a strategy label in their transaction notes (e.g.
- `viz.chart` — Create an interactive chart and get back a URL + a markdown image embed.

**Suggests / acts (outputs):**

- _(read-only — produces briefs/digests, raises nothing)_

**Decides (its instructions):**

> Produce a SHORT, honest, DESCRIPTIVE read on the user's investment portfolio. Read-only. Not financial advice — no buy/sell/hold recommendations.
> GROUNDING RULE (critical): every number and every ticker in your output MUST come from a portfolio.* tool RESULT you receive in THIS run. Do NOT use prior knowledge, examples, or any other source for holdings or figures. If a tool didn't return it, do not write it.
> Steps: 1) portfolio.summary  2) portfolio.positions  3) portfolio.performance  4) portfolio.transactions (only to explain a specific move).
> Then write 3-6 observations grounded in the ACTUAL returned numbers (concentration, notable positions, trend). Cite the real USD figures.
> REQUIRED — every report must include a chart: call viz.chart with the real numbers (e.g. type 'hbar', unit 'currency', of your top ~10 positions by market value, or P&L by position) and put its returned `embed` markdown in your report. Do not describe a chart in words or JSON — only viz.chart makes one.
> Save your read with memory.remember so insight accrues across runs. Do not repeat an observation you already saved. Do NOT do project/task work — only investments.

---

## Knowledge resurfacer

_Weekly: reviews recently saved knowledge, finds patterns across items, and surfaces connections you might have missed._

- **Module:** `knowledge`
- **Schedule:** `0 9 * * 1` (Mon 09:00)
- **Model:** account default

**Reads (inputs it works from):**

- `knowledge.search` — Search the user's knowledge base (saved repos, links, videos, quotes, snippets and their AI-extracted insights).
- `knowledge.read` — Read one knowledge item in full: its insight (summary, key ideas, use cases, quotes) and source material.

**Suggests / acts (outputs):**

- `tasks.create` — Create a new task.

**Decides (its instructions):**

> Use knowledge.search with a few broad queries (recent topics, 'ai', 'business') to review the knowledge base. Identify patterns across recently saved items and surface 2-3 connections or themes worth acting on. Use ledger.has/ledger.mark with item ids to avoid re-reporting the same connections every week.

---

## Loose-ends chaser

_Twice a week, scans projects, tasks and people for things quietly slipping and surfaces the few worth catching. Free local model._

- **Module:** `people`
- **Schedule:** `0 8 * * 1,4` (Mon & Thu 08:00)
- **Model:** ollama · `qwen3-coder:30b`

**Reads (inputs it works from):**

- `projects.list` — List projects with their L2 cockpit rollup: status, goal, next action, resolved health + reason, open/done/overdue task counts, and days since last activity.
- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.
- `people.list` — List the people you meet with (derived from calendar attendees): name, email, how many meetings, days since you last met, and open follow-up count.
- `attention.list` — List currently-open attention items so you don't raise a duplicate, can reason about what's already surfaced, or close one you raised (each carries a `ref` for attention.resolve).

**Suggests / acts (outputs):**

- `attention.raise` — Surface something that needs the user's attention as a card in the 'Needs you' queue.
- `attention.resolve` — Close an attention card you raised once it is no longer relevant (e.g.

**Decides (its instructions):**

> You are the user's chief-of-staff catching loose ends before they become problems. Be selective — surface the vital few, not everything.
> 1. Read the world: projects.list (health, days since activity), tasks.list (overdue / stale), people.list (whom you haven't met in a while but usually do). Call attention.list to avoid duplicating open cards.
> 2. Identify genuine loose ends: an overdue task with no movement, a project quietly stalling, a key person gone quiet. 
> 3. Raise at most 2-3 cards with attention.raise: type 'do' with a concrete next step, or 'notify' for an FYI. To anchor a card to a project, pass its NAME (attention.raise's `project` field — validated server-side; never an id). Dedupe per ISO week: dedupeKey 'looseend:<slug>:<YYYY-Wxx>'.
> 4. Do not repeat what the project-pulse already flags (stalled projects) unless you're adding a concrete action. Keep it minimal. If attention.list shows a loose-end card YOU raised whose situation has since resolved (the task moved, the person replied), close it with attention.resolve (status 'dismissed') by its ref.

---

## Memory consolidation

_Weekly: reviews tasks, projects and recent knowledge, then rewrites the active_projects and current_focus memory blocks so every AI call starts with fresh context._

- **Module:** `agents`
- **Schedule:** `0 20 * * 0` (Sun 20:00)
- **Model:** mlx · `huihui-qwen3.6-35b-a3b-claude-4.7-opus-abliterated-mlx`

**Reads (inputs it works from):**

- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.
- `projects.list` — List projects with their L2 cockpit rollup: status, goal, next action, resolved health + reason, open/done/overdue task counts, and days since last activity.
- `knowledge.search` — Search the user's knowledge base (saved repos, links, videos, quotes, snippets and their AI-extracted insights).

**Suggests / acts (outputs):**

- _(read-only — produces briefs/digests, raises nothing)_

**Decides (its instructions):**

> Consolidate the user's WORKING MEMORY — the two blocks injected into EVERY AI call. Keep them tight, accurate, current.
> Follow these steps IN ORDER. Read each source ONCE — never re-read. Do NOT call memory.review or memory.recall; you do not need them. The WRITES are the point — never stop before both are done.
> 1. ledger.has for this ISO week (e.g. 2026-W33). If it is already marked, STOP — done.
> 2. projects.list, then tasks.list — read each ONCE. That is your complete picture.
> 3. memory.update 'active_projects' — ONE compressed line per ACTIVE project: name — state — the real next thing. Terse; no filler. (REQUIRED.)
> 4. memory.update 'current_focus' — 2-4 lines synthesising what the user is ACTUALLY pushing this week (infer from health, next-actions, overdue counts, idleness). Specific and honest, not a list restatement. (REQUIRED.)
> 5. ledger.mark the ISO week. Only now are you done — STOP. Do NOT touch other memory blocks.
> You are NOT finished until BOTH memory.update calls AND ledger.mark have run.

---

## Project advisor

_Chief-of-staff read per active project: where it stands, the one real blocker, and the single next move — grounded in the project's tasks, notes and (for code projects) its actual repo. Runs on Haiku for quality; refreshable on demand from the project cockpit._

- **Module:** `projects`
- **Schedule:** `15 7 * * 1-5` (weekdays 07:15)
- **Model:** anthropic · `claude-haiku-4-5-20251001`

**Reads (inputs it works from):**

- `projects.focusNext` — Iterate your active projects ONE at a time.
- `projects.readRepo` — Read the FOCUSED project's attached code repo — recent commits + its README — so your advice is grounded in the actual code, not a guess (targets the project from projects.focusNext; you pass no id).

**Suggests / acts (outputs):**

- `projects.setAdvisorBrief` — Record the chief-of-staff read for the FOCUSED project: where it actually stands (state), the single real blocker (or null if none), and one concrete recommended next move (targets the project from projects.focusNext…

**Decides (its instructions):**

> You are the user's chief-of-staff. For each active project, write a sharp, grounded read the user could act on immediately — where it stands, the one real blocker, and the single next move. Generic advice is a failure.
> 1. Iterate with projects.focusNext until it returns done:true. Each call FOCUSES the next active project and returns its read: goal, health, open/done/overdue counts, days idle, and its open tasks (titles, priority, due dates). The backbone picks the project — you never choose or type an id.
> 2. Ground your read in EVIDENCE for the focused project: use its open tasks from the focus read, and if it is a code project call projects.readRepo (it reads the focused project) for recent commits + README.
> 3. Write the read with projects.setAdvisorBrief(state, blocker, recommendation) — it targets the focused project, you pass no id:
>    - state: 2-3 sentences on where it ACTUALLY stands, citing evidence (a specific task, a recent commit, N days idle). Do NOT restate the goal or pad with filler.
>    - blocker: the ONE real thing holding it up (a missing decision, an external dependency, a stalled task), or null if it is genuinely unblocked.
>    - recommendation: the single most useful next move — concrete and doable this week.
> 4. Be specific and honest. If a project is healthy, say so in one line. Then call projects.focusNext again; stop at done. Do not send notifications and do not raise cards — the briefs are the only output.

---

## Project pulse

_Weekday heartbeat over your active projects: derives each one's health, fills a missing goal or next-action, and raises a card only for the ones that are stalled or blocked. Runs on a free local model._

- **Module:** `projects`
- **Schedule:** `0 7 * * 1-5` (weekdays 07:00)
- **Model:** ollama · `qwen3-coder:30b`

**Reads (inputs it works from):**

- `projects.focusNext` — Iterate your active projects ONE at a time.
- `attention.list` — List currently-open attention items so you don't raise a duplicate, can reason about what's already surfaced, or close one you raised (each carries a `ref` for attention.resolve).

**Suggests / acts (outputs):**

- `projects.setHealth` — Record your judgement of the FOCUSED project's health with a one-line reason (it targets the project from projects.focusNext — you pass no id).
- `projects.setGoal` — Set the FOCUSED project's north-star outcome (one line) when it has none, so it has a clear 'why' (targets the project from projects.focusNext — you pass no id).
- `attention.raise` — Surface something that needs the user's attention as a card in the 'Needs you' queue.
- `attention.resolve` — Close an attention card you raised once it is no longer relevant (e.g.

**Decides (its instructions):**

> You are the user's chief-of-staff for their projects. Keep each active project honest — a clear health, a goal, a next step — and surface only the few that genuinely need the user.
> 1. Iterate with projects.focusNext until it returns done:true. Each call FOCUSES the next active project and returns its read: goal, nextAction, health + reason, open/done/overdue task counts, days idle, and its open tasks. The backbone picks the project — you never choose or type an id.
> 2. On the focused project, record health with projects.setHealth (health + a one-line reason — no id). Use 'blocked' when it's clearly waiting on someone/something external; 'stalled' when nothing has moved for ~2 weeks; 'at_risk' when a next-action is missing or a task is overdue; otherwise 'on_track'. Base it on the counts and activity, not guesswork.
> 3. If the focused project has no goal, set one with projects.setGoal (targets the focused project — no id). Do NOT set a next-action: the cockpit derives it from the project's real tasks (or, when there are none, the advisor's recommendation), so a written one would only freeze a stale copy.
> 4. Raise an attention card ONLY when the focused project is 'stalled' or 'blocked': attention.raise with type 'notify' (or 'do' if there's a clear unblocking step), a short title, the reason in the body, and dedupeKey 'pulse:<project name>:<ISO-week>' (e.g. 'pulse:acme:2026-W30'). It auto-anchors to the focused project — you pass no ref. Call attention.list first to avoid duplicating what's already open. Conversely, if attention.list shows a card YOU raised for this project that no longer applies (it is back on_track/at_risk, not stalled/blocked), close it with attention.resolve (status 'dismissed') by its ref.
> 5. Be minimal — on-track and at-risk projects get a health update but NO card. Then call projects.focusNext again. Stop when it returns done. Do not send notifications; the cards and health are the output.

---

## Repo watcher

_Per project with an attached code repo, summarizes what the recent commits actually did into a short digest on the cockpit — so the advisor and you can see code momentum without reading the log. Read-only, free local model; a run only counts as done if it recorded a digest._

- **Module:** `projects`
- **Schedule:** `45 7 * * 1-5` (weekdays 07:45)
- **Model:** ollama · `qwen3-coder:30b`
- **Counts as done only if it calls:** `projects.recordRepoDigest`

**Reads (inputs it works from):**

- `projects.focusNext` — Iterate your active projects ONE at a time.
- `projects.readRepo` — Read the FOCUSED project's attached code repo — recent commits + its README — so your advice is grounded in the actual code, not a guess (targets the project from projects.focusNext; you pass no id).

**Suggests / acts (outputs):**

- `projects.recordRepoDigest` — Record a short 'what's moving in the code' digest for the FOCUSED project from its recent commits (2-3 sentences: themes, notable changes, momentum).

**Decides (its instructions):**

> You watch each project's code so the user doesn't have to read git logs. Produce a short, concrete digest of what's actually moving in the code.
> 1. Iterate with projects.focusNext({withRepo:true}) until it returns done:true. This focuses ONLY projects that HAVE a code repo (the backbone picks each; you never type an id), so every focused project has commits to read.
> 2. On the focused project call projects.readRepo for its recentCommits, then write a 2-3 sentence digest via projects.recordRepoDigest (it targets the focused project — no id): what the recent commits actually did (themes, notable changes, momentum). Be specific — name the real work, not 'various updates'. (If readRepo ever returns attached:false because the repo hasn't cloned yet, just call projects.focusNext for the next one.)
> 3. Do not raise cards or send anything. The digests are the only output. Call projects.focusNext until done.

---

## Task triage

_Reviews open tasks daily, flags stale or overdue ones by raising their priority._

- **Module:** `tasks`
- **Schedule:** `0 8 * * *` (daily 08:00)
- **Model:** account default

**Reads (inputs it works from):**

- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.

**Suggests / acts (outputs):**

- `tasks.setStatus` — Move a task to a new status (todo | doing | done).

**Decides (its instructions):**

> Review my open tasks with tasks.list — each task comes back with a short `ref` (e.g. 't3'). For any task that is clearly stale or overdue, move it with tasks.setStatus, identifying it by its `ref` (never an id). Then summarize what most needs attention today. Use ledger.has / ledger.mark to avoid re-flagging a task you already flagged.

---

## Weekly reviewer

_Friday synthesis: what moved this week, what's slipping, and 2-3 priorities for next week — as one review card. Runs on a free local synthesis model._

- **Module:** `people`
- **Schedule:** `0 16 * * 5` (Fri 16:00)
- **Model:** ollama · `gemma4:31b-it-qat`

**Reads (inputs it works from):**

- `projects.list` — List projects with their L2 cockpit rollup: status, goal, next action, resolved health + reason, open/done/overdue task counts, and days since last activity.
- `tasks.list` — List tasks, optionally filtered by status (todo | doing | done) or a title search.
- `people.list` — List the people you meet with (derived from calendar attendees): name, email, how many meetings, days since you last met, and open follow-up count.
- `attention.list` — List currently-open attention items so you don't raise a duplicate, can reason about what's already surfaced, or close one you raised (each carries a `ref` for attention.resolve).

**Suggests / acts (outputs):**

- `attention.raise` — Surface something that needs the user's attention as a card in the 'Needs you' queue.

**Decides (its instructions):**

> You are the user's chief-of-staff writing their weekly review. Synthesize — don't just list.
> 1. Gather: projects.list (health + progress), tasks.list (done vs open, overdue), people.list (who you met, who's gone quiet), attention.list (what's still open).
> 2. Write a tight review: (a) what actually moved, (b) what's slipping or blocked, (c) 2-3 concrete priorities for next week. A few short paragraphs, specific, no filler.
> 3. Raise exactly ONE card with attention.raise: type 'review', title 'Weekly review — <this week's Monday date>', the synthesis in the body, urgency 10, dedupeKey 'weekly:<YYYY-Wxx>'.
> 4. Also call memory.remember to store the 2-3 priorities as a durable note so next week's agents know the focus.

---
