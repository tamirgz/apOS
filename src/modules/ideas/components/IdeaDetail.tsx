"use client";

import { act } from "@/core/ui/feedback";
import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  FolderKanban,
  Lightbulb,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import {
  deleteIdea,
  promoteToProject,
  requestAnalysis,
  setIdeaStage,
  updateIdeaNotes,
} from "../actions";
import type { Idea } from "../schema";
import { STAGE_META, STAGE_ORDER, VERDICT_META } from "./ideaMeta";

function Section({
  label,
  color,
  children,
}: {
  label: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass rounded-xl p-5">
      <p
        className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em]"
        style={{ color: color ?? "var(--color-gold)" }}
      >
        {label}
      </p>
      {children}
    </section>
  );
}

export function IdeaDetail({ idea }: { idea: Idea }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useLiveEvents(["ideas_changed"]);

  const stage = STAGE_META[idea.stage];
  const analysis = idea.analysis;
  const projectId = idea.projectRef?.split(":")[1];

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href="/m/ideas"
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
        >
          <ArrowLeft className="size-3" /> ideas
        </Link>
        <button
          type="button"
          onClick={() => {
            const next =
              STAGE_ORDER[
                (STAGE_ORDER.indexOf(idea.stage) + 1) % STAGE_ORDER.length
              ];
            startTransition(async () => {
              await setIdeaStage(idea.id, next);
            });
          }}
          title="Cycle stage"
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition hover:bg-white/5"
          style={{ color: stage.accent }}
        >
          <span className="dot" style={{ color: stage.accent }} />
          {idea.stage}
        </button>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {idea.category}
        </span>
        <button
          type="button"
          disabled={pending || idea.analysisStatus === "analyzing"}
          onClick={() =>
            startTransition(async () => {
              await requestAnalysis(idea.id);
            })
          }
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-gold/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-gold transition hover:bg-gold/25 disabled:opacity-40"
        >
          <Sparkles className="size-3" />
          {idea.analysisStatus === "analyzing"
            ? "analyzing…"
            : analysis
              ? "re-analyze"
              : "reality-check"}
        </button>
        {projectId ? (
          <Link
            href={`/m/projects/${projectId}`}
            className="flex items-center gap-1.5 rounded-lg border border-plasma/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
          >
            <FolderKanban className="size-3" /> project
          </Link>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const id = await promoteToProject(idea.id);
                router.push(`/m/projects/${id}`);
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-plasma/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/10 disabled:opacity-40"
          >
            <FolderKanban className="size-3" /> promote
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            startTransition(async () => {
              await deleteIdea(idea.id);
              router.push("/m/ideas");
            });
          }}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            confirmDelete
              ? "border-flare/50 bg-flare/15 text-flare"
              : "border-white/8 text-ink-faint hover:text-flare",
          )}
        >
          <Trash2 className="size-3" />
          {confirmDelete ? "sure?" : "delete"}
        </button>
      </div>

      <div className="mb-4 flex items-start gap-3">
        <Lightbulb className="mt-1 size-6 shrink-0 text-gold" />
        <h2 className="font-display text-2xl font-semibold leading-snug text-ink">
          {idea.title}
        </h2>
      </div>

      <div className="flex flex-col gap-4">
        {idea.analysisStatus === "error" && idea.analysisError && (
          <Section label="analysis error" color="var(--color-flare)">
            <p className="font-mono text-xs text-flare">{idea.analysisError}</p>
          </Section>
        )}

        {analysis && (
          <>
            <Section label="reality check">
              <div className="mb-3 flex items-center gap-3">
                <span
                  className="rounded-lg border px-3 py-1 font-mono text-xs uppercase tracking-widest"
                  style={{
                    color: VERDICT_META[analysis.verdict].color,
                    borderColor: `color-mix(in oklab, ${VERDICT_META[analysis.verdict].color} 40%, transparent)`,
                  }}
                >
                  {analysis.verdict}
                </span>
                <span className="font-display text-2xl font-semibold text-ink">
                  {analysis.score}
                  <span className="text-sm font-normal text-ink-faint">/10</span>
                </span>
              </div>
              <p className="text-sm leading-relaxed text-ink-dim">
                {analysis.summary}
              </p>
            </Section>

            {analysis.strengths.length > 0 && (
              <Section label="strengths" color="var(--color-plasma)">
                <ul className="flex flex-col gap-2">
                  {analysis.strengths.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-ink-dim">
                      <span className="font-mono text-plasma">+</span>
                      {s}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {analysis.risks.length > 0 && (
              <Section label="risks — the uncomfortable truths" color="var(--color-flare)">
                <ul className="flex flex-col gap-2">
                  {analysis.risks.map((r, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-ink-dim">
                      <span className="font-mono text-flare">!</span>
                      {r}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {analysis.validationSteps.length > 0 && (
              <Section label="validate or kill it fast" color="var(--color-ion)">
                <ul className="flex flex-col gap-2">
                  {analysis.validationSteps.map((v, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-ink">
                      <span className="font-mono text-ion">{i + 1}.</span>
                      {v}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}

        <Section label="notes" color="var(--color-ink-faint)">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                await act(() => updateIdeaNotes(idea.id, notesRef.current?.value ?? ""), {
                  failed: "Couldn't save the notes",
                  done: "Notes saved",
                });
              });
            }}
            className="flex flex-col gap-2"
          >
            <textarea
              ref={notesRef}
              defaultValue={idea.notes ?? ""}
              rows={3}
              placeholder="Context, angle, why now… (feeds the reality-check)"
              className="w-full resize-y rounded-lg border border-white/8 bg-transparent p-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-gold/40"
            />
            <button
              type="submit"
              disabled={pending}
              className="self-end rounded-lg bg-gold/15 px-4 py-1.5 font-mono text-[10px] uppercase tracking-widest text-gold transition hover:bg-gold/25 disabled:opacity-40"
            >
              save notes
            </button>
          </form>
        </Section>
      </div>
    </div>
  );
}
