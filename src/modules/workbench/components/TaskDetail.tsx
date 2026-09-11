"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  Check,
  FileDiff,
  GitPullRequest,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Scale,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import {
  acceptTask,
  archiveTask,
  cancelTask,
  deleteTask,
  requestPR,
  retryTask,
  setTaskProjects,
  unarchiveTask,
  updateTaskPrompt,
  updateTaskTitle,
} from "../actions";
import { ProjectMultiPicker } from "@/modules/projects/components/ProjectMultiPicker";
import type { ProjectOption } from "@/modules/projects/queries";
import type { TaskDetail as Detail } from "../queries";
import { STATUS_META } from "./TaskBoard";
import { ReportPanel } from "./ReportPanel";

const EVENT_COLOR: Record<string, string> = {
  status: "var(--color-ink-faint)",
  text: "var(--color-ink)",
  tool_call: "var(--color-ion)",
  tool_result: "var(--color-ink-faint)",
  summary: "var(--color-plasma)",
  result: "var(--color-plasma)",
  error: "var(--color-flare)",
  usage: "var(--color-ink-faint)",
};

function eventLine(e: Detail["events"][number]): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "status":
      return `· ${p.phase}${p.branch ? ` ${p.branch}` : ""}${p.model ? ` (${p.model})` : ""}`;
    case "tool_call":
      return `→ ${p.name} ${typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "")}`.slice(
        0,
        400,
      );
    case "tool_result": {
      // Tool results are usually objects — JSON-stringify so they don't render
      // as "[object Object]".
      const r =
        typeof p.result === "string"
          ? p.result
          : JSON.stringify(p.result ?? "");
      return `← ${r.slice(0, 300)}`;
    }
    case "summary":
      return `❯ ${p.text}`;
    case "result":
      return `✓ ${p.text ?? ""}`;
    case "error":
      return `✗ ${p.message}`;
    default:
      return String(p.text ?? JSON.stringify(p));
  }
}

/** Live tail — pinned to the bottom while running, like a real log. */
function EventTail({ events, live }: { events: Detail["events"]; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, live]);

  return (
    <div
      ref={ref}
      className="max-h-[52vh] overflow-y-auto rounded-xl border border-white/6 bg-abyss/50 p-3 font-mono text-[11px] leading-relaxed"
    >
      {events.length === 0 && (
        <p className="text-ink-faint">waiting for the executor to speak…</p>
      )}
      {events.map((e) => (
        <p
          key={e.id}
          dir="auto"
          className="whitespace-pre-wrap break-words"
          style={{ color: EVENT_COLOR[e.type] ?? "var(--color-ink-dim)" }}
        >
          {eventLine(e)}
        </p>
      ))}
    </div>
  );
}

function DiffPane({ diff }: { diff: NonNullable<Detail["diff"]> }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Split the unified patch per file so a big change stays readable.
  const perFile = new Map<string, string>();
  for (const chunk of diff.patch.split(/^diff --git /m).filter(Boolean)) {
    const name = chunk.match(/b\/(\S+)/)?.[1];
    if (name) perFile.set(name, `diff --git ${chunk}`);
  }

  return (
    <div className="flex flex-col gap-2">
      {diff.files.map((f) => (
        <div key={f.path}>
          <button
            type="button"
            onClick={() => setOpenFile(openFile === f.path ? null : f.path)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/4"
          >
            <FileDiff className="size-3.5 shrink-0 text-ion" />
            <span className="flex-1 truncate font-mono text-[11px] text-ink-dim">
              {f.path}
            </span>
            <span className="font-mono text-[10px] text-plasma">+{f.added}</span>
            <span className="font-mono text-[10px] text-flare">−{f.removed}</span>
          </button>
          {openFile === f.path && (
            <pre className="mt-1 max-h-80 overflow-auto rounded-lg border border-white/6 bg-void/60 p-3 font-mono text-[10px] leading-relaxed">
              {(perFile.get(f.path) ?? "").split("\n").map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    line.startsWith("+") && !line.startsWith("+++") && "text-plasma",
                    line.startsWith("-") && !line.startsWith("---") && "text-flare",
                    line.startsWith("@@") && "text-ion",
                    !/^[+\-@]/.test(line) && "text-ink-faint",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

interface Verdict {
  pass?: boolean;
  score?: number;
  gaps?: string[];
  rationale?: string;
}

/** The delegation judge's ruling — the automated ask↔result gate (A2 · Trust). */
function JudgePanel({
  status,
  verdict,
}: {
  status: string | null;
  verdict: Verdict | null;
}) {
  if (!status) return null;
  const meta =
    status === "pass"
      ? { color: "var(--color-plasma)", label: "verified — matches your ask" }
      : status === "retrying"
        ? { color: "var(--color-gold)", label: "judge flagged gaps — retrying with feedback" }
        : status === "fail"
          ? { color: "var(--color-flare)", label: "held — didn't meet the ask after a retry" }
          : status === "unverified"
            ? { color: "var(--color-gold)", label: "unverified — the judge couldn't run; review it yourself" }
            : { color: "var(--color-ink-faint)", label: status };

  return (
    <section
      className="glass rounded-2xl p-4"
      style={{ borderColor: `color-mix(in oklab, ${meta.color} 30%, transparent)` }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Scale className="size-3.5" style={{ color: meta.color }} />
        <p
          className="font-mono text-[10px] uppercase tracking-[0.3em]"
          style={{ color: meta.color }}
        >
          verifying judge · {meta.label}
        </p>
        {typeof verdict?.score === "number" && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint">
            {verdict.score}/100
          </span>
        )}
      </div>
      {verdict?.rationale && (
        <p className="text-sm leading-relaxed text-ink-dim">{verdict.rationale}</p>
      )}
      {verdict?.gaps && verdict.gaps.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {verdict.gaps.map((g, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-dim">
              <span style={{ color: meta.color }}>•</span>
              <span>{g}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TaskDetailView({
  detail,
  projectOptions = [],
}: {
  detail: Detail;
  projectOptions?: ProjectOption[];
}) {
  const { task, attempts, events, diff } = detail;
  const [pending, start] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingAsk, setEditingAsk] = useState(false);
  const [askDraft, setAskDraft] = useState(task.prompt);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const router = useRouter();
  const live = task.status === "running" || task.status === "queued";
  useLiveEvents(["workbench_changed"]);

  const latest = attempts[attempts.length - 1];
  const meta = STATUS_META[task.status];

  // Older claude-headless attempts didn't persist the model; recover it from
  // the "started (<model>)" event so the report's credit line is still honest.
  const ranModel =
    latest?.model ??
    (events
      .map((e) => (e.type === "status" ? (e.payload as { model?: string })?.model : null))
      .filter(Boolean)
      .pop() ??
      null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Link
          href="/m/workbench"
          className="mt-1 rounded-lg p-1.5 text-ink-faint transition hover:bg-white/6 hover:text-ink"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && titleDraft.trim()) {
                    start(async () => {
                      await updateTaskTitle(task.id, titleDraft);
                      setEditingTitle(false);
                      router.refresh();
                    });
                  }
                  if (e.key === "Escape") {
                    setTitleDraft(task.title);
                    setEditingTitle(false);
                  }
                }}
                className="flex-1 rounded-md bg-white/5 px-2 py-1 font-display text-xl font-semibold text-ink outline-none focus:bg-white/8"
              />
              <button
                type="button"
                disabled={pending || !titleDraft.trim()}
                onClick={() =>
                  start(async () => {
                    await updateTaskTitle(task.id, titleDraft);
                    setEditingTitle(false);
                    router.refresh();
                  })
                }
                className="rounded-md bg-plasma/15 p-1.5 text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
                title="Save header"
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(task.title);
                  setEditingTitle(false);
                }}
                className="rounded-md border border-white/8 p-1.5 text-ink-faint transition hover:text-ink-dim"
                title="Cancel"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <div className="group flex items-center gap-2">
              <h2 className="font-display text-xl font-semibold text-ink">
                {task.title}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(task.title);
                  setEditingTitle(true);
                }}
                title="Edit header"
                className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-white/6 hover:text-ink-dim group-hover:opacity-100"
              >
                <Pencil className="size-3.5" />
              </button>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            <span style={{ color: meta.color }}>{meta.label}</span>
            <span>{task.taskType}</span>
            {latest?.executorId && <span>{latest.executorId}</span>}
            {ranModel && <span>{ranModel}</span>}
            {latest?.branch && <span className="text-ion/70">{latest.branch}</span>}
            {latest?.inputTokens != null && (
              <span>
                {latest.inputTokens.toLocaleString()} in ·{" "}
                {(latest.outputTokens ?? 0).toLocaleString()} out
              </span>
            )}
            {latest?.costUsd && <span>${Number(latest.costUsd).toFixed(2)}</span>}
          </div>
          <div className="mt-2">
            <ProjectMultiPicker
              options={projectOptions}
              value={task.projectRefs ?? []}
              onChange={async (refs) => {
                await setTaskProjects(task.id, refs);
                router.refresh();
              }}
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {live && (
            <button
              type="button"
              disabled={pending}
              onClick={() => start(async () => void (await cancelTask(task.id)))}
              className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-flare/30 hover:text-flare disabled:opacity-40"
            >
              <Square className="size-3" />
              stop
            </button>
          )}
          {!live && (
            <button
              type="button"
              disabled={pending}
              onClick={() => start(async () => void (await retryTask(task.id)))}
              className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-ion/30 hover:text-ion disabled:opacity-40"
            >
              <RotateCw className="size-3" />
              retry
            </button>
          )}
          {/* Review OR held (needs_input) — either way the user has looked and
              can close it out. Held tasks previously had no way to be marked
              reviewed; this is that action. */}
          {(task.status === "review" || task.status === "needs_input") && (
            <button
              type="button"
              disabled={pending}
              onClick={() => start(async () => void (await acceptTask(task.id)))}
              title="Mark reviewed and close this out (done)"
              className="flex items-center gap-1.5 rounded-lg bg-plasma/15 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
            >
              <Check className="size-3" />
              {task.status === "needs_input" ? "mark reviewed" : "accept"}
            </button>
          )}
          {task.prUrl ? (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-plasma/30 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
            >
              <GitPullRequest className="size-3" />
              PR opened
            </a>
          ) : (
            !live &&
            task.repoPath &&
            diff &&
            diff.files.length > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => start(async () => void (await requestPR(task.id)))}
                title="Queue a PR for approval — pushes only after you approve"
                className="flex items-center gap-1.5 rounded-lg border border-ion/30 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10 disabled:opacity-40"
              >
                <GitPullRequest className="size-3" />
                request PR
              </button>
            )
          )}
          {task.archivedAt ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await unarchiveTask(task.id);
                  })
                }
                className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-ion/30 hover:text-ion disabled:opacity-40"
              >
                <RotateCcw className="size-3" />
                restore
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  confirmDelete
                    ? start(async () => {
                        await deleteTask(task.id);
                        router.push("/m/workbench");
                      })
                    : setConfirmDelete(true)
                }
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-40",
                  confirmDelete
                    ? "border-flare/40 bg-flare/15 text-flare hover:bg-flare/25"
                    : "border-white/8 text-ink-faint hover:border-flare/30 hover:text-flare",
                )}
              >
                <Trash2 className="size-3" />
                {confirmDelete ? "delete for good?" : "delete"}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await archiveTask(task.id);
                  // The card is hidden from the board now — don't strand the
                  // user on a page for something they can no longer find.
                  router.push("/m/workbench");
                })
              }
              title="Archive (removes the worktree, keeps the branch)"
              className="rounded-lg border border-white/8 p-2 text-ink-faint transition hover:text-ink disabled:opacity-40"
            >
              <Archive className="size-3" />
            </button>
          )}
        </div>
      </div>

      <JudgePanel
        status={task.judgeStatus}
        verdict={task.judgeVerdict as Verdict | null}
      />

      {latest?.result && (
        <section className="glass rounded-2xl p-5 sm:p-6">
          <ReportPanel
            attemptId={latest.id}
            taskId={task.id}
            result={latest.result}
            defaultTitle={
              latest.result.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || task.title
            }
            sourceUrl={task.prompt.match(/https?:\/\/[^\s)]+/)?.[0] ?? ""}
            model={ranModel}
            executorId={latest.executorId}
          />
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className="glass rounded-2xl p-4 lg:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
              the ask
            </p>
            {!editingAsk && !live && (
              <button
                type="button"
                title="Edit the request"
                onClick={() => {
                  setAskDraft(task.prompt);
                  setEditingAsk(true);
                }}
                className="rounded-md p-1 text-ink-faint transition hover:text-ion"
              >
                <Pencil className="size-3" />
              </button>
            )}
          </div>

          {editingAsk ? (
            <div className="flex flex-col gap-2">
              <textarea
                dir="auto"
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                rows={8}
                className="w-full resize-y rounded-lg border border-ion/25 bg-void/50 p-3 text-sm leading-relaxed text-ink outline-none focus:border-ion/50"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending || !askDraft.trim()}
                  onClick={() =>
                    start(async () => {
                      await updateTaskPrompt(task.id, askDraft);
                      setEditingAsk(false);
                    })
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
                >
                  <Check className="size-3" />
                  save
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setEditingAsk(false)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink disabled:opacity-40"
                >
                  <X className="size-3" />
                  cancel
                </button>
                <span className="font-mono text-[9px] text-ink-faint">
                  saving only — re-run when you&apos;re ready
                </span>
              </div>
            </div>
          ) : (
            <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-ink-dim">
              {task.prompt}
            </p>
          )}

          {!editingAsk && !live && (
            <button
              type="button"
              disabled={pending}
              onClick={() => start(async () => void (await retryTask(task.id)))}
              title="Run the delegation again with the current request"
              className="mt-3 flex items-center gap-1.5 rounded-lg border border-ion/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10 disabled:opacity-40"
            >
              <Play className="size-3" />
              re-run with this request
            </button>
          )}

          {task.repoPath && (
            <p className="mt-3 font-mono text-[10px] text-ink-faint">
              {task.repoPath}
            </p>
          )}
          {latest?.error && (
            <p className="mt-4 rounded-lg border border-flare/20 bg-flare/5 p-3 text-xs text-flare">
              {latest.error}
            </p>
          )}
        </section>

        <section className="glass rounded-2xl p-4 lg:col-span-3">
          <div className="mb-2 flex items-center gap-2">
            <Terminal className="size-3.5 text-ink-faint" />
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
              live tail
            </p>
            {live && <span className="dot animate-pulse-soft text-plasma" />}
          </div>
          <EventTail events={events} live={live} />
        </section>
      </div>

      {diff && diff.files.length > 0 && (
        <section className="glass rounded-2xl p-4">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
            diff · {diff.files.length} file(s) on {latest?.branch}
          </p>
          <DiffPane diff={diff} />
        </section>
      )}

      {attempts.length > 1 && (
        <section className="glass rounded-2xl p-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
            attempts
          </p>
          <div className="flex flex-col gap-1">
            {attempts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint"
              >
                <span className="w-6">#{a.seq}</span>
                <span className="flex-1 text-ink-dim">{a.executorId}</span>
                <span>{a.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
