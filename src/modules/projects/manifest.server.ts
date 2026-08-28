import type { ModuleServerManifest } from "@/core/modules/types.server";
import { features, projectFiles, projects } from "./schema";
import { projectTools } from "./tools";
import { projectFilesJobs } from "./files-pipeline";
import { projectRepoJobs } from "./repo-jobs";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ActiveProjectsWidget } from "./widgets/ActiveProjectsWidget";

export const projectsServerManifest: ModuleServerManifest = {
  id: "projects",
  routes: {
    "": ProjectsPage,
    "[id]": ProjectDetailPage,
  },
  widgets: [
    {
      id: "active-projects",
      title: "Active projects",
      size: "sm",
      component: ActiveProjectsWidget,
    },
  ],
  schema: { projects, projectFiles, features },
  aiTools: projectTools,
  jobs: [...projectFilesJobs, ...projectRepoJobs],
  agentTemplates: [
    {
      id: "project-pulse",
      name: "Project pulse",
      description:
        "Weekday heartbeat over your active projects: derives each one's health, fills a missing goal or next-action, and raises a card only for the ones that are stalled or blocked. Runs on a free local model.",
      // Iterate with projects.focusNext: the backbone binds one active project
      // at a time, so every write targets the RIGHT project — the model never
      // handles an id. Idempotent per project per ISO week via the dedupeKey.
      defaultPrompt: [
        "You are the user's chief-of-staff for their projects. Keep each active project honest — a clear health, a goal, a next step — and surface only the few that genuinely need the user.",
        "1. Iterate with projects.focusNext until it returns done:true. Each call FOCUSES the next active project and returns its read: goal, nextAction, health + reason, open/done/overdue task counts, days idle, and its open tasks. The backbone picks the project — you never choose or type an id.",
        "2. On the focused project, record health with projects.setHealth (health + a one-line reason — no id). Use 'blocked' when it's clearly waiting on someone/something external; 'stalled' when nothing has moved for ~2 weeks; 'at_risk' when a next-action is missing or a task is overdue; otherwise 'on_track'. Base it on the counts and activity, not guesswork.",
        "3. If the focused project has no goal, set one with projects.setGoal (targets the focused project — no id). Do NOT set a next-action: the cockpit derives it from the project's real tasks (or, when there are none, the advisor's recommendation), so a written one would only freeze a stale copy.",
        "4. Raise an attention card ONLY when the focused project is 'stalled' or 'blocked': attention.raise with type 'notify' (or 'do' if there's a clear unblocking step), a short title, the reason in the body, and dedupeKey 'pulse:<project name>:<ISO-week>' (e.g. 'pulse:acme:2026-W30'). It auto-anchors to the focused project — you pass no ref. Call attention.list first to avoid duplicating what's already open. Conversely, if attention.list shows a card YOU raised for this project that no longer applies (it is back on_track/at_risk, not stalled/blocked), close it with attention.resolve (status 'dismissed') by its ref.",
        "5. Be minimal — on-track and at-risk projects get a health update but NO card. Then call projects.focusNext again. Stop when it returns done. Do not send notifications; the cards and health are the output.",
      ].join("\n"),
      defaultTools: [
        "projects.focusNext",
        "projects.setHealth",
        "projects.setGoal",
        "attention.raise",
        "attention.list",
        "attention.resolve",
      ],
      defaultSchedule: "0 7 * * 1-5", // 07:00 weekdays — before the 07:30 planner
      // FREE local model — the heartbeat never bills (ONE-STOP §4). Chosen by a
      // 12-model bench of this exact task (2026-07-23): qwen3-coder:30b was the
      // only model that, across repeated runs, set correct health on every
      // project AND reliably raised stall/blocker cards — score 94 vs 42 for
      // qwen3:8b. See docs/EXECUTION-PLAN.md.
      defaultProvider: "ollama",
      defaultModel: "qwen3-coder:30b",
      // Iterating every active project via focusNext costs ~2-3 turns each, so
      // the default (8) truncated coverage at ~4 projects. Budget for the full
      // list plus margin.
      defaultTurnBudget: 60,
    },
    {
      id: "project-advisor",
      name: "Project advisor",
      description:
        "Chief-of-staff read per active project: where it stands, the one real blocker, and the single next move — grounded in the project's tasks, notes and (for code projects) its actual repo. Runs on Haiku for quality; refreshable on demand from the project cockpit.",
      defaultPrompt: [
        "You are the user's chief-of-staff. For each active project, write a sharp, grounded read the user could act on immediately — where it stands, the one real blocker, and the single next move. Generic advice is a failure.",
        "1. Iterate with projects.focusNext until it returns done:true. Each call FOCUSES the next active project and returns its read: goal, health, open/done/overdue counts, days idle, and its open tasks (titles, priority, due dates). The backbone picks the project — you never choose or type an id.",
        "2. Ground your read in EVIDENCE for the focused project: use its open tasks from the focus read, and if it is a code project call projects.readRepo (it reads the focused project) for recent commits + README.",
        "3. Write the read with projects.setAdvisorBrief(state, blocker, recommendation) — it targets the focused project, you pass no id:",
        "   - state: 2-3 sentences on where it ACTUALLY stands, citing evidence (a specific task, a recent commit, N days idle). Do NOT restate the goal or pad with filler.",
        "   - blocker: the ONE real thing holding it up (a missing decision, an external dependency, a stalled task), or null if it is genuinely unblocked.",
        "   - recommendation: the single most useful next move — concrete and doable this week.",
        "4. Be specific and honest. If a project is healthy, say so in one line. Then call projects.focusNext again; stop at done. Do not send notifications and do not raise cards — the briefs are the only output.",
      ].join("\n"),
      defaultTools: [
        "projects.focusNext",
        "projects.readRepo",
        "projects.setAdvisorBrief",
      ],
      defaultSchedule: "15 7 * * 1-5", // 07:15 weekdays — just after Project-pulse
      // Haiku: judgement-heavy synthesis where quality compounds (the advisor is
      // the brain). Cheap at a few projects/day; a deliberate metered exception
      // to the free-periodic rule, chosen by the user. Routable per-agent.
      defaultProvider: "anthropic",
      defaultModel: "claude-haiku-4-5-20251001",
      // Cover every active project (focusNext loop, ~2-3 turns each) instead of
      // truncating at the SDK default of 12.
      defaultTurnBudget: 60,
    },
    {
      // A1 — the first Routine: a repo watcher. Read-only (reads the read-only
      // clone), free local model, and GATED by A2 verification — the run is
      // only "done" if it actually recorded a digest (defaultSuccessTool).
      id: "repo-watcher",
      name: "Repo watcher",
      description:
        "Per project with an attached code repo, summarizes what the recent commits actually did into a short digest on the cockpit — so the advisor and you can see code momentum without reading the log. Read-only, free local model; a run only counts as done if it recorded a digest.",
      defaultPrompt: [
        "You watch each project's code so the user doesn't have to read git logs. Produce a short, concrete digest of what's actually moving in the code.",
        "1. Iterate with projects.focusNext({withRepo:true}) until it returns done:true. This focuses ONLY projects that HAVE a code repo (the backbone picks each; you never type an id), so every focused project has commits to read.",
        "2. On the focused project call projects.readRepo for its recentCommits, then write a 2-3 sentence digest via projects.recordRepoDigest (it targets the focused project — no id): what the recent commits actually did (themes, notable changes, momentum). Be specific — name the real work, not 'various updates'. (If readRepo ever returns attached:false because the repo hasn't cloned yet, just call projects.focusNext for the next one.)",
        "3. Do not raise cards or send anything. The digests are the only output. Call projects.focusNext until done.",
      ].join("\n"),
      defaultTools: [
        "projects.focusNext",
        "projects.readRepo",
        "projects.recordRepoDigest",
      ],
      // A2: the run fails unless it actually recorded at least one digest.
      defaultSuccessTool: "projects.recordRepoDigest",
      defaultSchedule: "45 7 * * 1-5", // weekday 07:45, after pulse/advisor
      // Read + summarize on the free bench-winner; never bills.
      defaultProvider: "ollama",
      defaultModel: "qwen3-coder:30b",
      // Visit every active project via focusNext (readRepo + recordRepoDigest
      // per repo project). ~2-3 turns each; budget for the full list plus margin.
      defaultTurnBudget: 60,
    },
  ],
};
