"use client";

import { useState, useTransition } from "react";
import { ArrowRight, Check, GitBranch, Pencil, Target, X } from "lucide-react";
import Link from "next/link";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { HEALTH_META } from "../health";
import { CategoryPicker } from "./CategoryPicker";
import type { ProjectHealth, ProjectStatus } from "../schema";

/** One inline-editable line (goal / next action). Enter or ✓ saves; Esc cancels. */
function EditableLine({
  value,
  placeholder,
  icon,
  accent,
  failedTitle,
  onSave,
  onComplete,
}: {
  value: string | null;
  placeholder: string;
  icon?: React.ReactNode;
  accent?: string;
  /** Error title when saving fails, e.g. "Couldn't save the goal". */
  failedTitle: string;
  onSave: (v: string | null) => Promise<void>;
  /** When set, a ✓ Done control appears while a value exists (next action). */
  onComplete?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [pending, startTransition] = useTransition();

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "")) return;
    startTransition(async () => {
      await act(() => onSave(next || null), { failed: failedTitle });
    });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value ?? "");
              setEditing(false);
            }
          }}
          onBlur={commit}
          placeholder={placeholder}
          className="h-8 min-w-0 flex-1 rounded-lg bg-ink/5 px-2.5 text-[13.5px] text-ink outline-none placeholder:text-ink-faint focus:bg-ink/8"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          className="rounded-md p-1.5 text-plasma transition hover:bg-plasma/10"
          title="Save"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setDraft(value ?? "");
            setEditing(false);
          }}
          className="rounded-md p-1.5 text-ink-faint transition hover:bg-ink/6 hover:text-ink"
          title="Cancel"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/line -ml-1.5 flex w-full items-start gap-2 rounded-lg px-1.5 py-1 transition hover:bg-ink/4",
        pending && "opacity-50",
      )}
    >
      <button
        type="button"
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        className="flex flex-1 items-start gap-2 text-left"
      >
        {icon && (
          <span className="mt-0.5 shrink-0" style={{ color: accent }}>
            {icon}
          </span>
        )}
        <span
          dir="auto"
          className={cn(
            "min-w-0 flex-1 break-words text-[13.5px] leading-snug",
            value ? "text-ink" : "text-ink-faint",
          )}
        >
          {value ?? placeholder}
        </span>
      </button>
      {onComplete && value && (
        <button
          type="button"
          onClick={() =>
            startTransition(async () => {
              await act(onComplete, { failed: "Couldn't complete the next action" });
            })
          }
          title="Mark done — records it and clears for the next step"
          className="wk-btn primary shrink-0 !gap-1 !px-2 !py-0.5 text-[11.5px]"
        >
          <Check className="size-3" /> Done
        </button>
      )}
      <Pencil className="mt-0.5 size-3 shrink-0 text-ink-faint opacity-0 transition group-hover/line:opacity-100" />
    </div>
  );
}

/**
 * The project's plan: goal, next action and repo as editable properties, with
 * the repo watcher's latest read of the code underneath.
 */
export function ProjectPlan({
  id,
  goal,
  nextAction,
  repoUrl,
  repoReady,
  repoDigest,
  setGoal,
  setNextAction,
  setRepo,
  completeNextAction,
}: {
  id: string;
  goal: string | null;
  nextAction: string | null;
  repoUrl: string | null;
  /** True once the read-only clone exists (or the local path is a git repo). */
  repoReady: boolean;
  /** Repo-watcher routine's latest "what's moving in the code" digest. */
  repoDigest: string | null;
  completeNextAction: (id: string) => Promise<void>;
  setGoal: (id: string, goal: string | null) => Promise<void>;
  setNextAction: (id: string, nextAction: string | null) => Promise<void>;
  setRepo: (id: string, repoUrl: string | null) => Promise<void>;
}) {
  // The worker announces repo-sync (and advisor) completion on this channel —
  // refresh so "cloning…" flips to "cloned" (and fresh reads appear) live.
  useLiveEvents(["projects_changed"]);

  return (
    <section aria-label="Plan" className="glass flex flex-col gap-3 rounded-2xl p-5">
      <h3 className="wk-sec-h">Plan</h3>
      <dl className="wk-props !grid-cols-[112px_minmax(0,1fr)] !items-start !gap-y-2">
        <dt className="pt-1.5">
          <Target className="size-3.5 text-plasma" /> Goal
        </dt>
        <dd>
          <EditableLine
            value={goal}
            placeholder="What outcome is this project for?"
            failedTitle="Couldn't save the goal"
            onSave={(v) => setGoal(id, v)}
          />
        </dd>
        <dt className="pt-1.5">
          <ArrowRight className="size-3.5 text-solar" /> Next action
        </dt>
        <dd>
          <EditableLine
            value={nextAction}
            placeholder="One concrete step"
            failedTitle="Couldn't save the next action"
            onSave={(v) => setNextAction(id, v)}
            onComplete={() => completeNextAction(id)}
          />
        </dd>
        <dt className="pt-1.5">
          <GitBranch className="size-3.5 text-ion" /> Repo
        </dt>
        <dd className="!flex-nowrap">
          <div className="min-w-0 flex-1">
            <EditableLine
              value={repoUrl}
              placeholder="GitHub URL or local path — agents read the real code"
              failedTitle="Couldn't attach the repo"
              onSave={(v) => setRepo(id, v)}
            />
          </div>
          {repoUrl && (
            <span
              className="wk-chip mt-0.5 shrink-0 !px-2 !py-px !text-[11px]"
              style={{ color: repoReady ? "var(--color-plasma)" : "var(--color-solar)" }}
              title={
                repoReady
                  ? "Read-only clone is ready — pick it as the repo when delegating a code task"
                  : "Cloning in the background — refresh in a moment"
              }
            >
              <i className="dot" />
              {repoReady ? "cloned" : "cloning…"}
            </span>
          )}
        </dd>
      </dl>
      {repoDigest && (
        <p dir="auto" className="wk-read plasma">
          <b>Repo watcher</b> · {repoDigest}
        </p>
      )}
    </section>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Health, category and the headline counts, for the Overview's side column. */
export function ProjectVitals({
  id,
  status,
  category,
  categories,
  health,
  healthReason,
  healthSource,
  stats,
  lastActive,
  setCategory,
}: {
  id: string;
  status: ProjectStatus;
  category: string | null;
  categories: string[];
  health: ProjectHealth;
  healthReason: string;
  healthSource: "agent" | "derived";
  stats: { open: number; done: number; overdue: number; notes: number };
  lastActive: string;
  setCategory: (id: string, category: string | null) => Promise<void>;
}) {
  const meta = HEALTH_META[health];
  const tiles: { label: string; n: number; href?: string; tone?: string }[] = [
    { label: "open", n: stats.open, href: "?tab=items" },
    { label: "done", n: stats.done },
    { label: "overdue", n: stats.overdue, href: "?tab=items", tone: stats.overdue > 0 ? "var(--color-flare)" : undefined },
    { label: "notes", n: stats.notes, href: "#project-notes" },
  ];
  return (
    <section aria-label="Health" className="glass flex flex-col gap-4 rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <h3 className="wk-sec-h">Health</h3>
        <span
          className="ml-auto text-[11px] text-ink-faint"
          title={healthSource === "agent" ? "Set by the Project-pulse agent" : "Derived from activity (no agent run yet)"}
        >
          {healthSource === "agent" ? "project pulse" : "from activity"} · {lastActive}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 font-display text-[22px] leading-tight" style={{ color: meta.accent }}>
          <i className="inline-block size-2.5 rounded-full" style={{ background: meta.accent }} />
          {cap(status === "active" ? meta.label : status)}
        </span>
        <p className="text-[13px] leading-snug text-ink-dim">{healthReason}</p>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {tiles.map((t) => {
          const body = (
            <>
              <span className="font-display text-[22px] leading-none tabular-nums text-ink" style={t.tone ? { color: t.tone } : undefined}>
                {t.n}
              </span>
              <span className="text-[11.5px] text-ink-faint">{t.label}</span>
            </>
          );
          const cls = "flex flex-col gap-1.5 rounded-xl border border-ion/10 bg-ink/[0.03] px-3 py-2.5";
          return t.href ? (
            <Link key={t.label} href={t.href} className={cn(cls, "transition hover:border-ion/25")}>
              {body}
            </Link>
          ) : (
            <div key={t.label} className={cls}>
              {body}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
        Category
        <CategoryPicker id={id} category={category} categories={categories} onSet={setCategory} />
      </div>
    </section>
  );
}
