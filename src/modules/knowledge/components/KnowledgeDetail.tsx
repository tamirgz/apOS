"use client";

import { act } from "@/core/ui/feedback";
import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import {
  deleteKnowledge,
  retryKnowledge,
  updateKnowledgeNote,
} from "../actions";
import type { KnowledgeItem } from "../schema";
import { KIND_META, STATUS_META } from "./kindMeta";

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass rounded-xl p-5">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-orchid">
        {label}
      </p>
      {children}
    </section>
  );
}

export function KnowledgeDetail({ item }: { item: KnowledgeItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useLiveEvents(["knowledge_changed"]);

  const kind = KIND_META[item.kind];
  const status = STATUS_META[item.status];
  const Icon = kind.icon;
  const insight = item.insight;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href="/m/knowledge"
          className="flex items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
        >
          <ArrowLeft className="size-3" /> knowledge
        </Link>
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
            status.pulse && "animate-pulse-soft",
          )}
          style={{ color: status.color }}
        >
          <span className="dot" style={{ color: status.color }} />
          {status.label}
        </span>
        {item.status === "error" && (
          <button
            type="button"
            onClick={() => startTransition(async () => retryKnowledge(item.id))}
            className="flex items-center gap-1.5 rounded-lg border border-solar/30 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest text-solar transition hover:bg-solar/10"
          >
            <RefreshCw className="size-3" /> retry
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            startTransition(async () => {
              await deleteKnowledge(item.id);
              router.push("/m/knowledge");
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
        <Icon className="mt-1.5 size-6" style={{ color: kind.color }} />
        <div>
          <h2 className="font-display text-2xl font-semibold text-ink">
            {item.title ?? item.input.slice(0, 80)}
          </h2>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-ion hover:underline"
            >
              {item.url.slice(0, 70)}
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {item.status === "error" && item.statusDetail && (
          <Section label="pipeline error">
            <p className="font-mono text-xs text-flare">{item.statusDetail}</p>
          </Section>
        )}

        {insight ? (
          <>
            <Section label="summary">
              <p className="text-sm leading-relaxed text-ink-dim">
                {insight.summary}
              </p>
              <p className="mt-3 border-l-2 border-orchid/40 pl-3 text-sm italic text-orchid/90">
                {insight.relevance}
              </p>
            </Section>

            {insight.useCases.length > 0 && (
              <Section label="use cases for you">
                <ul className="flex flex-col gap-2">
                  {insight.useCases.map((u, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-ink">
                      <span className="font-mono text-orchid">▸</span>
                      {u}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {insight.keyIdeas.length > 0 && (
              <Section label="key ideas">
                <ul className="flex flex-col gap-2">
                  {insight.keyIdeas.map((k, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-ink-dim">
                      <span className="font-mono text-ion">→</span>
                      {k}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {insight.quotes.length > 0 && (
              <Section label="quotes">
                {insight.quotes.map((q, i) => (
                  <blockquote
                    key={i}
                    className="mb-2 border-l-2 border-violet/40 pl-3 text-sm italic text-ink-dim"
                  >
                    “{q}”
                  </blockquote>
                ))}
              </Section>
            )}

            <div className="flex flex-wrap gap-2">
              {insight.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-lg border border-orchid/20 bg-orchid/5 px-2.5 py-1 font-mono text-[10px] text-orchid"
                >
                  {t}
                </span>
              ))}
            </div>
          </>
        ) : (
          item.status !== "error" && (
            <Section label="analysis">
              <p className="animate-pulse-soft font-mono text-xs uppercase tracking-widest text-ink-faint">
                the pipeline is working on this item…
              </p>
            </Section>
          )
        )}

        <Section label="your note">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = noteRef.current?.value ?? "";
              startTransition(async () =>
                void (await act(() => updateKnowledgeNote(item.id, v), { failed: "Couldn't save the note", done: "Note saved" })),
              );
            }}
            className="flex flex-col gap-2"
          >
            <textarea
              ref={noteRef}
              defaultValue={item.note ?? ""}
              rows={2}
              placeholder="Why did you save this?"
              className="w-full resize-y rounded-lg border border-white/8 bg-transparent p-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-orchid/40"
            />
            <button
              type="submit"
              disabled={pending}
              className="self-end rounded-lg bg-orchid/15 px-4 py-1.5 font-mono text-[10px] uppercase tracking-widest text-orchid transition hover:bg-orchid/25 disabled:opacity-40"
            >
              save note
            </button>
          </form>
        </Section>

        <details className="group">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint transition hover:text-ink-dim">
            raw material
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-xl border border-white/6 bg-abyss/60 p-4 font-mono text-[11px] leading-relaxed text-ink-faint">
            {JSON.stringify({ input: item.input, raw: item.raw }, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
