"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Lightbulb,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import {
  createIdea,
  deleteIdea,
  requestAnalysis,
  setIdeaStage,
} from "../actions";
import type { Idea, IdeaCategory } from "../schema";
import {
  CATEGORY_LABEL,
  STAGE_META,
  STAGE_ORDER,
  VERDICT_META,
} from "./ideaMeta";
import { IDEA_CATEGORIES } from "../schema";

function QuickAdd() {
  const [pending, startTransition] = useTransition();
  const [category, setCategory] = useState<IdeaCategory>("product");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const title = inputRef.current?.value.trim();
        if (!title || pending) return;
        startTransition(async () => {
          const r = await act(() => createIdea({ title, category }), { failed: "Couldn't capture the idea" });
          if (!r.ok) return;
          if (inputRef.current) inputRef.current.value = "";
        });
      }}
      className="glass mb-4 flex items-center gap-2 rounded-xl p-1.5 pl-3 focus-within:glass-edge"
    >
      <Lightbulb className="size-4 text-gold" />
      <input
        ref={inputRef}
        placeholder="Capture a new idea…"
        disabled={pending}
        autoFocus
        className="h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <button
        type="button"
        onClick={() =>
          setCategory(
            (c) =>
              IDEA_CATEGORIES[
                (IDEA_CATEGORIES.indexOf(c) + 1) % IDEA_CATEGORIES.length
              ],
          )
        }
        title={`Category: ${category} (click to cycle)`}
        className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5"
      >
        <Tag className="size-3.5" />
        {category}
      </button>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-gold/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-gold transition hover:bg-gold/25 disabled:opacity-40"
      >
        {pending ? "…" : "add"}
      </button>
    </form>
  );
}

function IdeaCard({ idea }: { idea: Idea }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const idx = STAGE_ORDER.indexOf(idea.stage);
  const move = (dir: -1 | 1) => {
    const next = STAGE_ORDER[idx + dir];
    if (!next) return;
    startTransition(async () => {
      await act(() => setIdeaStage(idea.id, next), { failed: "Couldn't move the idea" });
    });
  };
  const analysis = idea.analysis;

  return (
    <motion.div
      layout
      layoutId={idea.id}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: pending ? 0.4 : 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className="group glass cursor-pointer rounded-xl p-3.5"
      onClick={() => router.push(`/m/ideas/${idea.id}`)}
    >
      <p className="text-sm leading-snug text-ink">{idea.title}</p>
      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          {CATEGORY_LABEL[idea.category]}
        </span>
        {idea.analysisStatus === "analyzing" && (
          <span className="animate-pulse-soft font-mono text-[9px] uppercase tracking-widest text-solar">
            analyzing…
          </span>
        )}
        {idea.analysisStatus === "ready" && analysis && (
          <span
            className="rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
            style={{
              color: VERDICT_META[analysis.verdict].color,
              borderColor: `color-mix(in oklab, ${VERDICT_META[analysis.verdict].color} 35%, transparent)`,
            }}
          >
            {analysis.verdict} · {analysis.score}/10
          </span>
        )}
        {idea.projectRef && (
          <span className="font-mono text-[9px] uppercase tracking-widest text-plasma">
            → project
          </span>
        )}
      </div>
      <div
        className="mt-2 flex items-center justify-between opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={idx === 0 || pending}
            title="Move left"
            className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink disabled:invisible"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={idx === STAGE_ORDER.length - 1 || pending}
            title="Move right"
            className="rounded-md p-1.5 text-ink-dim transition hover:bg-white/6 hover:text-ink disabled:invisible"
          >
            <ArrowRight className="size-3.5" />
          </button>
        </div>
        <div className="flex gap-1">
          {idea.analysisStatus !== "analyzing" && (
            <button
              type="button"
              title="AI reality-check"
              onClick={() =>
                startTransition(async () => {
                  await act(() => requestAnalysis(idea.id), { failed: "Couldn't start the reality-check" });
                })
              }
              className="rounded-md p-1.5 text-ink-faint transition hover:bg-gold/10 hover:text-gold"
            >
              <Sparkles className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            title="Delete idea"
            onClick={() =>
              startTransition(async () => {
                await act(() => deleteIdea(idea.id), { failed: "Couldn't delete the idea" });
              })
            }
            className="rounded-md p-1.5 text-ink-faint transition hover:bg-flare/10 hover:text-flare"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export function IdeasBoard({ items }: { items: Idea[] }) {
  useLiveEvents(["ideas_changed"]);

  return (
    <div>
      <QuickAdd />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {STAGE_ORDER.map((stage) => {
          const meta = STAGE_META[stage];
          const stageItems = items.filter((i) => i.stage === stage);
          return (
            <section key={stage} className="min-h-40">
              <header className="mb-3 flex items-center gap-2 px-1">
                <span className="dot" style={{ color: meta.accent }} />
                <h2 className="font-display text-sm font-medium uppercase tracking-[0.2em] text-ink-dim">
                  {meta.label}
                </h2>
                <span className="ml-auto font-mono text-xs tabular-nums text-ink-faint">
                  {stageItems.length}
                </span>
              </header>
              <div className="flex flex-col gap-2.5">
                <AnimatePresence mode="popLayout">
                  {stageItems.map((i) => (
                    <IdeaCard key={i.id} idea={i} />
                  ))}
                </AnimatePresence>
                {stageItems.length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/6 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    empty
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
