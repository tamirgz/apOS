"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Repeat,
  Play,
  Plus,
  Trash2,
  GitPullRequest,
  ChevronDown,
  Check,
  Sparkles,
} from "lucide-react";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { act } from "@/core/ui/feedback";
import { cn } from "@/core/ui/cn";
import {
  composeRoutine,
  createRoutineFromUI,
  deleteRoutine,
  runRoutineNow,
  setRoutineEnabled,
  updateRoutine,
} from "../actions";
import type { Routine } from "../queries";

interface ProjectOpt {
  id: string;
  name: string;
}
interface ExecutorOpt {
  id: string;
  name: string;
}

/** A row + an expandable panel exposing every property of the routine. */
function RoutineRow({
  r,
  executors,
  freeModels,
}: {
  r: Routine;
  executors: ExecutorOpt[];
  /** Free models per executor id — the picker options, already namespaced
   *  (`ollama/<tag>` for opencode) so a pick can't drop the provider prefix. */
  freeModels: Record<string, string[]>;
}) {
  const [pending, start] = useTransition();
  const [openDetail, setOpenDetail] = useState(false);
  const on = r.enabled === "true";

  // editable fields
  const [name, setName] = useState(r.name);
  const [prompt, setPrompt] = useState(r.prompt);
  const [executorId, setExecutorId] = useState(r.executorId);
  const [model, setModel] = useState(r.model ?? "");
  const [trigger, setTrigger] = useState(r.triggerKind);
  const [schedule, setSchedule] = useState(r.schedule ?? "");
  const [deliverPr, setDeliverPr] = useState(r.deliverPr === "true");
  const [gateEnabled, setGateEnabled] = useState(r.gateEnabled === "true");
  const [gateModel, setGateModel] = useState(r.gateModel ?? "");

  const dirty =
    name !== r.name ||
    prompt !== r.prompt ||
    executorId !== r.executorId ||
    model !== (r.model ?? "") ||
    trigger !== r.triggerKind ||
    schedule !== (r.schedule ?? "") ||
    deliverPr !== (r.deliverPr === "true") ||
    gateEnabled !== (r.gateEnabled === "true") ||
    gateModel !== (r.gateModel ?? "");

  const triggerLabel =
    r.triggerKind === "commit"
      ? "on commit"
      : r.triggerKind === "schedule"
        ? `cron ${r.schedule}`
        : `commit + ${r.schedule}`;

  const fmt = (d: Date | null) =>
    d ? new Date(d).toLocaleString() : "never";

  return (
    <div className="rounded-xl border border-white/6 bg-void/30">
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          title={on ? "Enabled — click to pause" : "Paused — click to enable"}
          disabled={pending}
          onClick={() => start(async () => void (await act(() => setRoutineEnabled(r.id, !on), { failed: "Couldn't change the routine" })))}
          className={`size-2.5 shrink-0 rounded-full transition ${on ? "bg-plasma shadow-[0_0_8px_var(--color-plasma)]" : "bg-ink-faint/40"}`}
        />
        <button
          type="button"
          onClick={() => setOpenDetail((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="truncate text-sm text-ink">{r.name}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            <span className="text-ion/70">{triggerLabel}</span>
            <span>{r.executorId}</span>
            {r.deliverPr === "true" && (
              <span className="flex items-center gap-0.5 text-plasma/70">
                <GitPullRequest className="size-2.5" /> PR
              </span>
            )}
            {r.prUrl && (
              <a
                href={r.prUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-0.5 text-plasma underline hover:text-plasma/80"
              >
                open PR
              </a>
            )}
          </div>
        </button>
        <ChevronDown
          className={`size-3.5 shrink-0 text-ink-faint transition ${openDetail ? "rotate-180" : ""}`}
        />
        <button
          type="button"
          title="Run now"
          disabled={pending}
          onClick={() =>
            start(async () =>
              void (await act(() => runRoutineNow(r.id), {
                failed: "Couldn't start the routine",
                done: `${r.name} queued`,
                href: "/m/workbench",
              })),
            )
          }
          className="rounded-md p-1.5 text-ink-faint transition hover:text-ion"
        >
          <Play className="size-3.5" />
        </button>
        <button
          type="button"
          title="Delete routine"
          disabled={pending}
          onClick={() => start(async () => void (await act(() => deleteRoutine(r.id), { failed: "Couldn't delete the routine" })))}
          className="rounded-md p-1.5 text-ink-faint transition hover:text-flare"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {openDetail && (
        <div className="flex flex-col gap-3 border-t border-white/6 p-3">
          <label className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            title
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Routine title"
            className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink outline-none focus:border-ion/40"
          />
          <label className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            the ask
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            className="resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-ion/40"
          />
          <div className="flex flex-wrap gap-2">
            <select
              value={executorId}
              onChange={(e) => setExecutorId(e.target.value)}
              className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
            >
              {executors.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={`rt-models-${r.id}`}
              placeholder="model (blank = executor default)"
              className="w-56 rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-xs text-ink-dim outline-none focus:border-ion/40"
            />
            {/* Same free-model catalog as the one-shot box — picking one keeps
                the `ollama/` prefix, so a local model can't be misread as cloud. */}
            <datalist id={`rt-models-${r.id}`}>
              {(freeModels[executorId] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as typeof trigger)}
              className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
            >
              <option value="commit">on each commit</option>
              <option value="schedule">on a schedule</option>
              <option value="both">commit + schedule</option>
            </select>
            {trigger !== "commit" && (
              <input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="cron"
                className="w-40 rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-xs text-ink-dim outline-none focus:border-ion/40"
              />
            )}
            <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
              <input
                type="checkbox"
                checked={deliverPr}
                onChange={(e) => setDeliverPr(e.target.checked)}
              />
              deliver PR
            </label>
          </div>

          {/* Attention filter: a cheap/free model decides per commit whether the
              change is worth the executor. Only meaningful for commit triggers. */}
          {(trigger === "commit" || trigger === "both") && (
            <div className="flex flex-col gap-2 rounded-xl border border-ion/15 bg-ion/[0.03] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim">
                  <input
                    type="checkbox"
                    checked={gateEnabled}
                    onChange={(e) => setGateEnabled(e.target.checked)}
                  />
                  relevance gate
                </label>
                {gateEnabled && (
                  <>
                    <input
                      value={gateModel}
                      onChange={(e) => setGateModel(e.target.value)}
                      list={`rt-gate-models-${r.id}`}
                      placeholder="gate model (blank = default routine.gate)"
                      className="w-64 rounded-lg border border-white/8 bg-void/50 px-3 py-1.5 font-mono text-[11px] text-ink-dim outline-none focus:border-ion/40"
                    />
                    <datalist id={`rt-gate-models-${r.id}`}>
                      {(freeModels[executorId] ?? freeModels.opencode ?? []).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </>
                )}
              </div>
              <p className="font-mono text-[9px] leading-relaxed text-ink-faint">
                {gateEnabled
                  ? "Free per-commit check — the executor runs only on commits it flags relevant. Fail-closed (skips on doubt). “Run now” bypasses it."
                  : "Off — the executor runs on every commit."}
              </p>
              {r.lastGateRelevant && (
                <p className="font-mono text-[9px] text-ink-faint">
                  last gate:{" "}
                  <span className={r.lastGateRelevant === "true" ? "text-plasma/80" : "text-ink-dim"}>
                    {r.lastGateRelevant === "true" ? "relevant → ran" : "skipped"}
                  </span>
                  {r.lastGateWhy ? ` — ${r.lastGateWhy}` : ""}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] text-ink-faint sm:grid-cols-3">
            <span>repo: <span className="text-ink-dim">{r.repoPath?.split("/").pop() ?? "—"}</span></span>
            <span>last commit seen: <span className="text-ink-dim">{r.lastSeenSha?.slice(0, 8) ?? "—"}</span></span>
            <span>last fired: <span className="text-ink-dim">{fmt(r.lastFiredAt)}</span></span>
            <span>gate: <span className="text-ink-dim">skipped {r.gateSkipped} · ran {r.gateRan}</span></span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() =>
                start(async () => {
                  await act(() => updateRoutine(r.id, {
                    name,
                    prompt,
                    executorId,
                    model: model.trim() || null,
                    triggerKind: trigger,
                    schedule: trigger === "commit" ? null : schedule,
                    deliverPr,
                    gateEnabled,
                    gateModel: gateModel.trim() || null,
                  }), { failed: "Couldn't save the routine", done: "Routine saved" });
                })
              }
              className="flex items-center gap-1.5 rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
            >
              <Check className="size-3" />
              save
            </button>
            {r.lastTaskId && (
              <Link
                href={`/m/workbench/${r.lastTaskId}`}
                className="font-mono text-[10px] uppercase tracking-widest text-ink-faint underline hover:text-ink"
              >
                last run →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Routines (A1) — the recurring delegations. Each fires on a new commit and/or
 * a schedule, runs through the judge, and delivers as an approval-gated PR.
 */
export function RoutinesPanel({
  routines,
  projects,
  executors,
  freeModels,
  sources = [],
}: {
  routines: Routine[];
  projects: ProjectOpt[];
  executors: ExecutorOpt[];
  /** Free models per executor id — namespaced (`ollama/<tag>` for opencode). */
  freeModels: Record<string, string[]>;
  sources?: { ref: string; label: string }[];
}) {
  useLiveEvents(["routines_changed"]);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  // create-form state
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [executorId, setExecutorId] = useState("opencode");
  const [newModel, setNewModel] = useState("");
  const [trigger, setTrigger] = useState<"commit" | "schedule" | "both" | "source">("commit");
  const [schedule, setSchedule] = useState("0 8 * * 1-5");
  const [sourceRef, setSourceRef] = useState(sources[0]?.ref ?? "");

  // builder: describe → cheap model composes the config (keeps your ask)
  const [describe, setDescribe] = useState("");
  const [composing, setComposing] = useState(false);
  const [builderNote, setBuilderNote] = useState<null | { ok: boolean; text: string }>(null);

  const canSave = name.trim() && projectId && prompt.trim().length > 10;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <Repeat className="size-4 text-ion" />
        <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ink-faint">
          routines
        </h3>
        <span className="font-mono text-[10px] text-ink-faint">{routines.length}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-ion/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10"
        >
          <Plus className="size-3" />
          new routine
        </button>
      </div>

      {open && (
        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-ion/20 bg-void/40 p-4">
          {/* Builder: describe it → a cheap model fills in the config below. */}
          <div className="flex flex-col gap-2 rounded-xl border border-gold/20 bg-gold/[0.03] p-3">
            <label className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-gold/80">
              <Sparkles className="size-3" />
              describe it — AI fills in the setup (keeps your wording)
            </label>
            <textarea
              value={describe}
              onChange={(e) => setDescribe(e.target.value)}
              rows={2}
              placeholder="e.g. On each commit to NoClick, update the docs HTML if the change affects them; flag the investor deck but don't edit it."
              className="resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-gold/40"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={composing || describe.trim().length < 10}
                onClick={() =>
                  start(async () => {
                    setComposing(true);
                    setBuilderNote(null);
                    const r = await act(() => composeRoutine(describe), {
                      failed: "Couldn't compose the routine",
                      checkResult: false,
                    });
                    setComposing(false);
                    if (!r.ok) return;
                    const res = r.value;
                    if (res.ok) {
                      setName(res.draft.name);
                      setPrompt(res.draft.ask);
                      setTrigger(res.draft.triggerKind);
                      if (res.draft.schedule) setSchedule(res.draft.schedule);
                      setBuilderNote({ ok: true, text: res.draft.note ?? "Filled in below — review and save." });
                    } else {
                      setBuilderNote({ ok: false, text: res.error });
                    }
                  })
                }
                className="flex items-center gap-1.5 rounded-lg bg-gold/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-gold transition hover:bg-gold/25 disabled:opacity-40"
              >
                <Sparkles className="size-3" />
                {composing ? "composing…" : "compose with AI"}
              </button>
              {builderNote && (
                <span className={cn("font-mono text-[9px]", builderNote.ok ? "text-ink-faint" : "text-flare")}>
                  {builderNote.text}
                </span>
              )}
            </div>
          </div>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Routine name — e.g. NoClick doc-sync"
            className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink outline-none focus:border-ion/40"
          />
          <div className="flex flex-wrap gap-2">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={executorId}
              onChange={(e) => setExecutorId(e.target.value)}
              className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
            >
              {executors.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              list="rt-models-new"
              placeholder="model (blank = executor default, e.g. ollama/qwen3-coder:30b)"
              className="w-64 rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-xs text-ink-dim outline-none focus:border-ion/40"
            />
            {/* This executor's free models — same list as the one-shot box, so a
                pick lands with its provider prefix (`ollama/…`) intact. */}
            <datalist id="rt-models-new">
              {(freeModels[executorId] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value as typeof trigger)}
              className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
            >
              <option value="commit">on each commit</option>
              <option value="schedule">on a schedule</option>
              <option value="both">commit + schedule</option>
              {sources.length > 0 && <option value="source">on a new source post</option>}
            </select>
            {(trigger === "schedule" || trigger === "both") && (
              <input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="cron e.g. 0 8 * * 1-5"
                className="w-40 rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-xs text-ink-dim outline-none focus:border-ion/40"
              />
            )}
            {trigger === "source" && (
              <select
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink-dim outline-none"
              >
                {sources.map((s) => (
                  <option key={s.ref} value={s.ref}>{s.label}</option>
                ))}
              </select>
            )}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="The standing ask, run on every trigger. e.g. Analyze the latest commit and keep docs/Capability-Matrix.html and docs/OnePager.html in sync…"
            className="resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-ion/40"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canSave || pending}
              onClick={() =>
                start(async () => {
                  const r = await act(() => createRoutineFromUI({
                    name,
                    projectId,
                    prompt,
                    executorId,
                    model: newModel.trim() || null,
                    triggerKind: trigger,
                    schedule: trigger === "schedule" || trigger === "both" ? schedule : null,
                    sourceRef: trigger === "source" ? sourceRef : null,
                  }), { failed: "Couldn't create the routine", done: "Routine created" });
                  if (!r.ok) return;
                  setName("");
                  setPrompt("");
                  setOpen(false);
                })
              }
              className="rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
            >
              create routine
            </button>
            <span className="font-mono text-[9px] text-ink-faint">
              delivered as an approval-gated PR — never a direct write
            </span>
          </div>
        </div>
      )}

      {routines.length === 0 && !open ? (
        <p className="rounded-xl border border-white/6 bg-void/30 p-4 text-xs text-ink-faint">
          No routines yet. A routine runs your ask on every new commit (or a
          schedule), verifies the result, and opens a PR for you to approve.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {routines.map((r) => (
            <RoutineRow key={r.id} r={r} executors={executors} freeModels={freeModels} />
          ))}
        </div>
      )}
    </section>
  );
}
