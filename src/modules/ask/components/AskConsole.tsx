"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { motion } from "motion/react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  Bell,
  BookMarked,
  CheckSquare,
  Check,
  BookOpen,
  ChevronDown,
  Download,
  FileText,
  FolderKanban,
  Globe,
  History,
  Lightbulb,
  Paperclip,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/core/ui/cn";
import { reflowCollapsedTables } from "@/core/ui/reflowTables";
import { useDraft } from "@/core/ui/useDraft";
import {
  ask,
  clipAnswerToObsidian,
  deleteAskHistoryEntry,
  renameAskEntry,
  setAskProjects,
} from "../actions";
import { ProjectMultiPicker } from "@/modules/projects/components/ProjectMultiPicker";
import type { ProjectOption } from "@/modules/projects/queries";
import type { AskAnswer, AskSource } from "../answer";
import type { AskHistoryEntry } from "../schema";

const KIND_ICON: Record<string, typeof FileText> = {
  note: FileText,
  knowledge: BookOpen,
  vault: BookOpen,
  idea: Lightbulb,
  task: CheckSquare,
  notion: FileText,
  file: Paperclip,
  project: FolderKanban,
  attention: Bell,
  web: Globe,
};

/**
 * Render the answer as real markdown (headings, bold, lists, rules, links) with
 * inline `[n]` citations turned into clickable source chips. The model returns
 * rich markdown; showing it raw (the old behaviour) surfaced literal `###`/`**`.
 * Standalone `[n]` become `cite:n` links so the markdown parser keeps them
 * inline; a `[n](url)` markdown link is left alone (negative lookahead).
 */
function CitedAnswer({ text, sources }: { text: string; sources: AskSource[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  // The generator now HTTP-verifies external enrichment links, so keep them.
  // As a fast client-side net (also covers answers stored before verification),
  // demote to plain text any link that isn't a professional source:
  //   - paywalled/login-gated domains — a Gartner link 200s but walls its
  //     content, so a live check can't catch it, but the domain can;
  //   - tertiary/crowd/blog/SEO domains (Wikipedia, Medium, Reddit…) — reachable
  //     but not authoritative enough to cite in a professional answer.
  const lowQuality =
    /\[([^\]]+)\]\((?:https?:)?\/\/(?:www\.)?(?:gartner|forrester|idc|statista|wsj|ft|bloomberg|nytimes|economist|hbr|wikipedia|wikimedia|wiktionary|medium|substack|blogspot|wordpress|quora|reddit|stackoverflow|stackexchange|geeksforgeeks|w3schools|tutorialspoint|javatpoint|baeldung|hackernoon|freecodecamp|simplilearn|guru99|educative|programiz|towardsdatascience)\.[a-z.]+[^)\s]*\)/gi;
  const cleaned = reflowCollapsedTables(text.replace(lowQuality, "$1"));
  const withCitations = cleaned.replace(/\[(\d+)\](?!\()/g, (whole, n) =>
    byN.has(Number(n)) ? `[${n}](cite:${n})` : whole,
  );

  const components: Components = {
    h1: ({ node: _n, ...p }) => (
      <h1 className="mt-5 mb-2 font-display text-xl font-semibold text-ink first:mt-0" {...p} />
    ),
    h2: ({ node: _n, ...p }) => (
      <h2 className="mt-5 mb-2 font-display text-lg font-semibold text-ink first:mt-0" {...p} />
    ),
    h3: ({ node: _n, ...p }) => (
      <h3 className="mt-4 mb-1.5 font-display text-base font-medium text-ink first:mt-0" {...p} />
    ),
    p: ({ node: _n, ...p }) => (
      <p className="mb-3 text-[15px] leading-relaxed text-ink-dim" {...p} />
    ),
    strong: ({ node: _n, ...p }) => <strong className="font-semibold text-ink" {...p} />,
    em: ({ node: _n, ...p }) => <em className="text-ink-dim/90" {...p} />,
    ul: ({ node: _n, ...p }) => (
      <ul className="mb-3 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-dim marker:text-ink-faint" {...p} />
    ),
    ol: ({ node: _n, ...p }) => (
      <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-dim marker:text-ink-faint" {...p} />
    ),
    li: ({ node: _n, ...p }) => <li className="pl-1 leading-relaxed" {...p} />,
    code: ({ node: _n, ...p }) => (
      <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[12px] text-ion" {...p} />
    ),
    pre: ({ node: _n, ...p }) => (
      <pre className="mb-3 overflow-x-auto rounded-lg border border-white/6 bg-black/30 p-3 font-mono text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" {...p} />
    ),
    blockquote: ({ node: _n, ...p }) => (
      <blockquote className="mb-3 border-l-2 border-violet/40 pl-3 text-[15px] italic text-ink-dim" {...p} />
    ),
    hr: () => <hr className="my-4 border-white/8" />,
    table: ({ node: _n, ...p }) => (
      <div className="mb-3 overflow-x-auto rounded-lg border border-white/8">
        <table className="w-full border-collapse text-[13px]" {...p} />
      </div>
    ),
    thead: ({ node: _n, ...p }) => <thead className="bg-white/[0.04]" {...p} />,
    tr: ({ node: _n, ...p }) => <tr {...p} />,
    th: ({ node: _n, ...p }) => (
      <th className="border-b border-white/10 px-3 py-2 text-left align-top font-mono text-[10px] uppercase tracking-widest text-ink-dim" {...p} />
    ),
    td: ({ node: _n, ...p }) => (
      <td className="border-b border-white/6 px-3 py-2 align-top leading-relaxed text-ink-dim [&:not(:last-child)]:border-r [&:not(:last-child)]:border-white/6" {...p} />
    ),
    a: ({ node: _n, href, children }) => {
      const m = /^cite:(\d+)$/.exec(href ?? "");
      if (m) {
        const s = byN.get(Number(m[1]));
        if (s)
          return (
            <Link
              href={s.href}
              title={s.title}
              className="mx-0.5 rounded bg-plasma/15 px-1 align-super font-mono text-[11px] leading-none text-plasma no-underline transition hover:bg-plasma/30"
            >
              {children}
            </Link>
          );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-ion underline decoration-ion/40 underline-offset-2 transition hover:decoration-ion"
        >
          {children}
        </a>
      );
    },
  };

  // `dir="auto"` so a Hebrew answer reads RTL and an English one LTR.
  return (
    <div dir="auto" className="ask-answer">
      <ReactMarkdown
        // GFM for tables (the answer uses them), strikethrough and task lists.
        remarkPlugins={[remarkGfm]}
        components={components}
        // Keep default URL sanitization for real links, but allow our internal
        // `cite:n` scheme through (otherwise it's stripped and citations lose
        // their href, falling back to plain external links).
        urlTransform={(url) =>
          url.startsWith("cite:") ? url : defaultUrlTransform(url)
        }
      >
        {withCitations}
      </ReactMarkdown>
    </div>
  );
}

function formatWhen(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AskConsole({
  initialHistory,
  projectOptions = [],
}: {
  initialHistory: AskHistoryEntry[];
  projectOptions?: ProjectOption[];
}) {
  const [pending, start] = useTransition();
  const [, startDelete] = useTransition();
  const [result, setResult] = useState<AskAnswer | null>(null);
  const [asked, setAsked] = useState("");
  const [history, setHistory] = useState<AskHistoryEntry[]>(initialHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Save-to-Obsidian (same raw/ destination + format as Workbench outcomes).
  const [clipPending, startClip] = useTransition();
  const [clipOpen, setClipOpen] = useState(false);
  const [clipTitle, setClipTitle] = useState("");
  const [clip, setClip] = useState<{ ok?: string; err?: string }>({});
  // Editable header for the current answer (null = show the question).
  const [entryTitle, setEntryTitle] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titlePending, startTitle] = useTransition();
  // Which projects/areas the current answer is filed under.
  const [entryProjectRefs, setEntryProjectRefs] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Keep a half-written question across navigation to another module and back.
  const clearDraft = useDraft("ask:draft", inputRef);

  const submit = () => {
    const q = inputRef.current?.value.trim();
    if (!q || pending) return;
    setAsked(q);
    setResult(null);
    setActiveId(null);
    setEntryTitle(null);
    setEntryProjectRefs([]);
    setTitleEditing(false);
    start(async () => {
      const r = await ask(q);
      setResult(r);
      if (r.historyId) {
        setActiveId(r.historyId);
        setHistory((prev) => [
          {
            id: r.historyId!,
            query: q,
            title: null,
            projectRefs: [],
            answer: r.answer,
            sources: r.sources,
            model: r.model || null,
            createdAt: new Date(),
          },
          ...prev,
        ]);
      }
      if (inputRef.current) inputRef.current.value = "";
      clearDraft();
    });
  };

  // Deep-link: /m/ask?q=… fills the box and asks immediately — this is what
  // "Ask about this project" buttons link to. window.location (not
  // useSearchParams) avoids the CSR-bailout Suspense requirement.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (autoAsked.current) return;
    autoAsked.current = true;
    const q = new URLSearchParams(window.location.search).get("q")?.trim();
    if (q && inputRef.current) {
      inputRef.current.value = q;
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Instant — no retrieval, no LLM call, just the already-computed answer.
  const loadFromHistory = (entry: AskHistoryEntry) => {
    setAsked(entry.query);
    setResult({ answer: entry.answer, sources: entry.sources, model: entry.model ?? "" });
    setActiveId(entry.id);
    setEntryTitle(entry.title ?? null);
    setEntryProjectRefs(entry.projectRefs ?? []);
    setTitleEditing(false);
    setClipOpen(false);
    setClip({});
  };

  const openTitleEdit = () => {
    setTitleDraft(entryTitle ?? asked);
    setTitleEditing(true);
  };

  const saveTitle = () => {
    if (!activeId) return;
    const t = titleDraft.trim();
    startTitle(async () => {
      await renameAskEntry(activeId, t);
      setEntryTitle(t || null);
      setHistory((prev) =>
        prev.map((h) => (h.id === activeId ? { ...h, title: t || null } : h)),
      );
      setTitleEditing(false);
    });
  };

  const openClip = () => {
    setClipTitle(asked.trim().slice(0, 120) || "Ask answer");
    setClip({});
    setClipOpen(true);
  };

  const doClip = () => {
    if (!result) return;
    startClip(async () => {
      try {
        const { path } = await clipAnswerToObsidian({
          title: clipTitle,
          answer: result.answer,
          sources: result.sources,
          model: result.model || null,
          createdISODate: new Date().toISOString().slice(0, 10),
        });
        setClip({ ok: path.split("/").slice(-2).join("/") });
        setClipOpen(false);
      } catch (e) {
        setClip({ err: e instanceof Error ? e.message : String(e) });
      }
    });
  };

  const deleteEntry = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHistory((prev) => prev.filter((h) => h.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setAsked("");
      setResult(null);
    }
    startDelete(async () => {
      await deleteAskHistoryEntry(id);
    });
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="text-center">
        <Sparkles className="mx-auto mb-2 size-6 text-plasma" />
        <h1 className="font-display text-2xl font-semibold text-ink">Ask your knowledge</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Cited answers from your notes, knowledge, vault, ideas, tasks and files — nothing from outside.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="glass flex items-end gap-2 rounded-2xl p-2 pl-4 focus-within:glass-edge"
      >
        <textarea
          ref={inputRef}
          rows={1}
          placeholder="Ask anything about what you've saved…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
          autoFocus
        />
        <button
          type="submit"
          disabled={pending}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-plasma/20 text-plasma transition hover:bg-plasma/30 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>

      <div>
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          className="flex items-center gap-2 rounded-lg px-1 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink-dim"
        >
          <History className="size-3.5" />
          recent questions
          <span className="tabular-nums text-ink-faint">{history.length}</span>
          <ChevronDown className={cn("size-3 transition-transform", historyOpen && "rotate-180")} />
        </button>
        {historyOpen && (
          <div className="mt-2 flex flex-col gap-1.5">
            {history.length === 0 && (
              <p className="py-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                no questions yet
              </p>
            )}
            {history.map((h) => (
              <div
                key={h.id}
                className={cn(
                  "group glass flex items-center gap-2 rounded-xl px-3 py-2 transition",
                  activeId === h.id ? "bg-plasma/8" : "hover:bg-white/4",
                )}
              >
                <button
                  type="button"
                  onClick={() => loadFromHistory(h)}
                  title="Show this answer — already computed, no re-query"
                  className="min-w-0 flex-1 truncate text-left text-sm text-ink-dim transition hover:text-ink"
                >
                  {h.title?.trim() || h.query}
                </button>
                <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                  {formatWhen(h.createdAt)}
                </span>
                <button
                  type="button"
                  title="Delete this question"
                  onClick={(e) => deleteEntry(h.id, e)}
                  className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition group-hover:opacity-100 hover:bg-flare/10 hover:text-flare"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {asked && (
        <div className="flex flex-col gap-4">
          {titleEditing ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setTitleEditing(false);
                }}
                placeholder="Give this answer a header…"
                className="h-8 flex-1 rounded-md bg-white/5 px-2 text-sm text-ink outline-none focus:bg-white/8"
              />
              <button
                type="button"
                disabled={titlePending}
                onClick={saveTitle}
                className="rounded-md bg-plasma/15 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
              >
                save
              </button>
              <button
                type="button"
                onClick={() => setTitleEditing(false)}
                className="rounded-md border border-white/8 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-ink-faint transition hover:text-ink-dim"
              >
                cancel
              </button>
            </div>
          ) : (
            <div className="group flex items-center gap-2">
              <p
                dir="auto"
                className={cn(
                  "min-w-0 flex-1 font-mono text-[11px] uppercase tracking-widest",
                  entryTitle ? "text-ink-dim" : "text-ink-faint",
                )}
              >
                {entryTitle?.trim() || asked}
              </p>
              {activeId && (
                <button
                  type="button"
                  onClick={openTitleEdit}
                  title={entryTitle ? "Edit header" : "Add a header"}
                  className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-white/6 hover:text-ink-dim group-hover:opacity-100"
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </div>
          )}

          {pending && (
            <div className="flex items-center gap-2 text-sm text-ink-dim">
              <span className="size-1.5 animate-ping rounded-full bg-plasma" />
              searching your corpus & composing a cited answer…
            </div>
          )}

          {result && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-5"
            >
              <div className="glass rounded-2xl p-5">
                <CitedAnswer text={result.answer} sources={result.sources} />
                {(result.model || activeId) && (
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/6 pt-2">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                      {result.model}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {activeId && (
                        <ProjectMultiPicker
                          options={projectOptions}
                          value={entryProjectRefs}
                          onChange={async (refs) => {
                            setEntryProjectRefs(refs);
                            await setAskProjects(activeId, refs);
                            setHistory((prev) =>
                              prev.map((h) =>
                                h.id === activeId ? { ...h, projectRefs: refs } : h,
                              ),
                            );
                          }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={openClip}
                        title="Save this answer into your Obsidian vault's raw/ folder"
                        className="flex items-center gap-1.5 rounded-lg border border-ion/25 bg-ion/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-ion transition hover:bg-ion/20"
                      >
                        <BookMarked className="size-3" />
                        obsidian
                      </button>
                      {activeId && (
                        <a
                          href={`/api/ask/${activeId}/pdf`}
                          title="Download this answer as a structured PDF report"
                          className="flex items-center gap-1.5 rounded-lg bg-plasma/10 px-2.5 py-1 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20"
                        >
                          <Download className="size-3" />
                          export pdf
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {clipOpen && (
                  <div className="glass mt-3 flex flex-col gap-2 rounded-lg p-3">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                      clip to obsidian → raw/
                    </p>
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                        title
                      </span>
                      <input
                        value={clipTitle}
                        onChange={(e) => setClipTitle(e.target.value)}
                        className="h-8 rounded-md bg-white/5 px-2 text-sm text-ink outline-none focus:bg-white/8"
                      />
                    </label>
                    {clip.err && <p className="text-xs text-flare">{clip.err}</p>}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={clipPending}
                        onClick={doClip}
                        className="flex items-center gap-1.5 rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
                      >
                        <BookMarked className="size-3.5" /> {clipPending ? "saving…" : "add to raw"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setClipOpen(false)}
                        className="rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink-dim"
                      >
                        cancel
                      </button>
                    </div>
                  </div>
                )}

                {clip.ok && !clipOpen && (
                  <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-ion/20 bg-ion/5 px-3 py-2 text-xs text-ion">
                    <Check className="size-3.5" /> saved to{" "}
                    <span className="font-mono">{clip.ok}</span> — your raw→wiki automation will take it from here.
                  </p>
                )}
              </div>

              {result.sources.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-dim">
                    sources
                  </p>
                  {result.sources.map((s) => {
                    const Icon = KIND_ICON[s.kind] ?? FileText;
                    // Web sources are absolute URLs → open in a new tab; internal
                    // sources use client-side routing.
                    const external = /^https?:\/\//.test(s.href);
                    const rowClass =
                      "glass group flex items-center gap-3 rounded-xl p-3 transition hover:bg-white/4";
                    const inner = (
                      <>
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-plasma/10 font-mono text-[10px] text-plasma">
                          {s.n}
                        </span>
                        <Icon className="size-3.5 shrink-0 text-ink-faint" />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
                          {s.title}
                        </span>
                        <span className={cn("shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint")}>
                          {s.kind}
                        </span>
                      </>
                    );
                    return external ? (
                      <a
                        key={s.n}
                        href={s.href}
                        target="_blank"
                        rel="noreferrer"
                        className={rowClass}
                      >
                        {inner}
                      </a>
                    ) : (
                      <Link key={s.n} href={s.href} className={rowClass}>
                        {inner}
                      </Link>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}
