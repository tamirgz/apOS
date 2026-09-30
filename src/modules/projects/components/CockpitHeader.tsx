"use client";

import { useState, useTransition } from "react";
import { ArrowRight, Check, GitBranch, Pencil, Target, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { HealthChip } from "./HealthChip";
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
  icon: React.ReactNode;
  accent: string;
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
      <div className="flex items-center gap-2">
        <span className="shrink-0" style={{ color: accent }}>
          {icon}
        </span>
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
          className="h-8 flex-1 rounded-lg bg-white/5 px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
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
          className="rounded-md p-1.5 text-ink-faint transition hover:bg-white/6 hover:text-ink"
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
        "group/line flex w-full items-start gap-2 rounded-lg px-1.5 py-1 transition hover:bg-white/4",
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
        <span className="mt-0.5 shrink-0" style={{ color: accent }}>
          {icon}
        </span>
        <span
          className={cn(
            "flex-1 text-sm leading-snug",
            value ? "text-ink-dim" : "text-ink-faint italic",
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
          className="flex shrink-0 items-center gap-1 rounded-md border border-plasma/25 bg-plasma/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20"
        >
          <Check className="size-3" /> done
        </button>
      )}
      <Pencil className="mt-0.5 size-3 shrink-0 text-ink-faint opacity-0 transition group-hover/line:opacity-100" />
    </div>
  );
}

export function CockpitHeader({
  id,
  status,
  goal,
  category,
  categories,
  nextAction,
  repoUrl,
  repoReady,
  repoDigest,
  health,
  healthReason,
  healthSource,
  stats,
  lastActive,
  setGoal,
  setCategory,
  setNextAction,
  setRepo,
  completeNextAction,
}: {
  id: string;
  status: ProjectStatus;
  goal: string | null;
  category: string | null;
  categories: string[];
  nextAction: string | null;
  repoUrl: string | null;
  /** True once the read-only clone exists (or the local path is a git repo). */
  repoReady: boolean;
  /** Repo-watcher routine's latest "what's moving in the code" digest. */
  repoDigest: string | null;
  health: ProjectHealth;
  healthReason: string;
  healthSource: "agent" | "derived";
  stats: { open: number; done: number; overdue: number; notes: number; attention: number };
  lastActive: string;
  completeNextAction: (id: string) => Promise<void>;
  setGoal: (id: string, goal: string | null) => Promise<void>;
  setCategory: (id: string, category: string | null) => Promise<void>;
  setNextAction: (id: string, nextAction: string | null) => Promise<void>;
  setRepo: (id: string, repoUrl: string | null) => Promise<void>;
}) {
  // The worker announces repo-sync (and advisor) completion on this channel —
  // refresh so "cloning…" flips to "cloned" (and fresh reads appear) live.
  useLiveEvents(["projects_changed"]);

  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2.5">
        {status === "active" && (
          <HealthChip health={health} reason={healthReason} />
        )}
        <span className="text-sm text-ink-dim">{healthReason}</span>
        <span className="ml-auto">
          <CategoryPicker
            id={id}
            category={category}
            categories={categories}
            onSet={setCategory}
          />
        </span>
        <span
          className="font-mono text-[9px] uppercase tracking-widest text-ink-faint"
          title={
            healthSource === "agent"
              ? "set by the Project-pulse agent"
              : "derived from activity (no agent run yet)"
          }
        >
          {healthSource === "agent" ? "pulse" : "auto"}
        </span>
      </div>

      <div className="flex flex-col gap-1 border-t border-white/6 pt-3">
        <EditableLine
          value={goal}
          placeholder="Set the goal — what outcome is this project for?"
          icon={<Target className="size-3.5" />}
          accent="var(--color-plasma)"
          failedTitle="Couldn't save the goal"
          onSave={(v) => setGoal(id, v)}
        />
        <EditableLine
          value={nextAction}
          placeholder="Set the next action — one concrete step"
          icon={<ArrowRight className="size-3.5" />}
          accent="var(--color-solar)"
          failedTitle="Couldn't save the next action"
          onSave={(v) => setNextAction(id, v)}
          onComplete={() => completeNextAction(id)}
        />
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <EditableLine
              value={repoUrl}
              placeholder="Attach a code repo — GitHub URL or local path (agents read the real code)"
              icon={<GitBranch className="size-3.5" />}
              accent="var(--color-ion)"
              failedTitle="Couldn't attach the repo"
              onSave={(v) => setRepo(id, v)}
            />
          </div>
          {repoUrl && (
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest",
                repoReady ? "bg-plasma/10 text-plasma" : "bg-solar/10 text-solar",
              )}
              title={
                repoReady
                  ? "Read-only clone is ready — pick it as the repo when delegating a code task"
                  : "Cloning in the background — refresh in a moment"
              }
            >
              {repoReady ? "cloned" : "cloning…"}
            </span>
          )}
        </div>
        {repoDigest && (
          <p className="flex items-start gap-1.5 pl-1.5 text-xs leading-snug text-ink-faint">
            <GitBranch className="mt-0.5 size-3 shrink-0 text-ion/60" />
            <span>
              <span className="font-mono text-[9px] uppercase tracking-widest text-ion/50">
                code ·{" "}
              </span>
              {repoDigest}
            </span>
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/6 pt-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        <span>{lastActive}</span>
        <span className="tabular-nums">{stats.open} open</span>
        <span className="tabular-nums">{stats.done} done</span>
        {stats.overdue > 0 && (
          <span className="tabular-nums text-flare">{stats.overdue} overdue</span>
        )}
        {stats.notes > 0 && <span className="tabular-nums">{stats.notes} notes</span>}
        {stats.attention > 0 && (
          <span className="tabular-nums text-solar">{stats.attention} needs you</span>
        )}
      </div>
    </div>
  );
}
