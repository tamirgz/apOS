"use client";

import { useEffect, useState, useTransition } from "react";
import { Code, FileClock, GitCompare, ScrollText, ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { Markdown } from "@/core/ui/Markdown";
import { timeAgo } from "@/core/ui/time";
import { diffProjectDoc, projectDocHistory, readProjectDoc } from "../docs-actions";

export interface ProjectDocRow {
  key: string;
  title: string;
  version: number;
  updatedAt: Date;
  updatedBy: string;
}

type Opened = Awaited<ReturnType<typeof readProjectDoc>>;
type History = Awaited<ReturnType<typeof projectDocHistory>>;
type Pane = "read" | "history" | "diff";

const who = (by: string) => by.replace(/^agent:/, "").replace(/#\w+$/, "");
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * A project's docs — durable state agents keep through the docs.* tools
 * (resume notes, standing decisions). Read-only here: the list, one doc's body
 * rendered as markdown (or exactly as stored, under Source), its version
 * history, and a diff between any two versions.
 */
export function ProjectDocs({ projectId, docs }: { projectId: string; docs: ProjectDocRow[] }) {
  const [key, setKey] = useState<string | null>(docs[0]?.key ?? null);
  const [version, setVersion] = useState<number | undefined>();
  const [pane, setPane] = useState<Pane>("read");
  const [doc, setDoc] = useState<Opened>(null);
  const [history, setHistory] = useState<History>([]);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  // Rendered markdown by default; Source shows the body byte for byte.
  const [source, setSource] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!key) return;
    start(async () => {
      const [d, h] = await Promise.all([readProjectDoc(projectId, key, version), projectDocHistory(projectId, key)]);
      setDoc(d);
      setHistory(h);
    });
  }, [projectId, key, version]);

  useEffect(() => {
    if (!key || pane !== "diff" || !history.length) return;
    const latest = history[0].version;
    const [from, to] = range ?? [Math.max(1, latest - 1), latest];
    start(async () => setDiff(await diffProjectDoc(projectId, key, from, to)));
  }, [projectId, key, pane, range, history]);

  if (!docs.length) {
    return (
      <section className="glass rounded-2xl p-8 text-center text-sm text-ink-faint">
        No docs yet. Agents keep a project&apos;s durable state here — resume notes, standing decisions, open questions — with the{" "}
        <span className="font-mono text-ink-dim">docs.put</span> tool. Docs aren&apos;t work items: they never count toward lists, cycles or milestones.
      </section>
    );
  }

  const open = (k: string) => {
    setKey(k);
    setVersion(undefined);
    setRange(null);
    setPane("read");
  };
  const latest = history[0]?.version ?? doc?.latestVersion ?? 0;
  const [from, to] = range ?? [Math.max(1, latest - 1), latest];
  const versions = history.map((h) => h.version);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <nav aria-label="Docs" className="glass flex flex-col gap-1 rounded-2xl p-2">
        {docs.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => open(d.key)}
            aria-current={d.key === key}
            className={cn(
              "flex flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition",
              d.key === key ? "bg-plasma/10 text-ink" : "text-ink-dim hover:bg-ink/[0.04] hover:text-ink",
            )}
          >
            <span className="truncate text-[13px] font-medium">{d.title}</span>
            <span className="flex items-center gap-2 font-mono text-[11px] text-ink-faint">
              <span className="truncate">{d.key}</span>
              <span className="ml-auto shrink-0 tabular-nums">v{d.version}</span>
              <span className="shrink-0" suppressHydrationWarning>
                {timeAgo(d.updatedAt, { compact: true })}
              </span>
            </span>
          </button>
        ))}
      </nav>

      <section aria-label="Doc" className={cn("glass flex min-w-0 flex-col gap-3 rounded-2xl p-5", pending && "opacity-70")}>
        {doc && (
          <>
            <header className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold text-ink">{doc.title}</h3>
              <span className="wk-chip font-mono">{doc.key}</span>
              <span className="wk-chip font-mono tabular-nums">
                v{doc.version}
                {doc.version !== doc.latestVersion && <span className="text-solar"> · latest v{doc.latestVersion}</span>}
              </span>
              {doc.deleted && <span className="wk-chip text-flare">deleted</span>}
              <div role="tablist" className="ml-auto flex gap-1">
                {(
                  [
                    ["read", "Read", ScrollText],
                    ["history", `History ${history.length}`, FileClock],
                    ["diff", "Diff", GitCompare],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={pane === id}
                    onClick={() => setPane(id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] transition",
                      pane === id ? "bg-plasma/15 text-ink" : "text-ink-faint hover:text-ink-dim",
                    )}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
              </div>
            </header>

            {pane === "read" && (
              <>
                <div className="-mb-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setSource((s) => !s)}
                    aria-pressed={source}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[11px] transition",
                      source ? "bg-plasma/15 text-ink" : "text-ink-faint hover:text-ink-dim",
                    )}
                    title={source ? "Show the rendered markdown" : "Show the stored text exactly as written"}
                  >
                    <Code className="size-3.5" /> Source
                  </button>
                </div>
                {source ? (
                  <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ink/[0.03] p-4 font-mono text-[12.5px] leading-relaxed text-ink-dim">
                    {doc.body}
                  </pre>
                ) : (
                  <article className="max-h-[70vh] overflow-auto rounded-xl bg-ink/[0.03] px-5 py-4">
                    <Markdown size="note">{doc.body}</Markdown>
                  </article>
                )}
              </>
            )}

            {pane === "history" && (
              <ol className="flex flex-col divide-y divide-ion/10">
                {history.map((h) => (
                  <li key={h.version} className="flex items-center gap-3 py-2 text-[12.5px]">
                    <button
                      type="button"
                      onClick={() => {
                        setVersion(h.version === latest ? undefined : h.version);
                        setPane("read");
                      }}
                      className="font-mono tabular-nums text-plasma hover:underline"
                    >
                      v{h.version}
                    </button>
                    <span className="truncate text-ink-dim">
                      {h.change === "delete" ? "deleted" : h.title} · {who(h.updatedBy)}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-faint">{kb(h.sizeBytes)}</span>
                    <span
                      className={cn("flex shrink-0 items-center gap-1 text-[11px]", h.guarded ? "text-ink-faint" : "text-solar")}
                      title={h.guarded ? "Guarded write — it named the version it replaced" : "Unguarded write — it didn't check for a newer version"}
                    >
                      {h.guarded ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                      {h.guarded ? "guarded" : "unguarded"}
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-[11px] text-ink-faint" suppressHydrationWarning>
                      {timeAgo(h.updatedAt, { compact: true })}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {pane === "diff" && (
              <>
                <div className="flex items-center gap-2 text-[12px] text-ink-dim">
                  from
                  <select value={from} onChange={(e) => setRange([Number(e.target.value), to])} className="wk-inline font-mono">
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        v{v}
                      </option>
                    ))}
                  </select>
                  to
                  <select value={to} onChange={(e) => setRange([from, Number(e.target.value)])} className="wk-inline font-mono">
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        v{v}
                      </option>
                    ))}
                  </select>
                </div>
                <pre className="max-h-[70vh] overflow-auto rounded-xl bg-ink/[0.03] p-4 font-mono text-[12px] leading-relaxed">
                  {diff === null
                    ? "…"
                    : diff === ""
                      ? <span className="text-ink-faint">No differences.</span>
                      : diff.split("\n").map((l, i) => (
                          <div
                            key={i}
                            className={cn(
                              "whitespace-pre-wrap break-words",
                              l.startsWith("+") ? "bg-plasma/10 text-plasma" : l.startsWith("-") ? "bg-flare/10 text-flare" : l === "@@" ? "text-ion/60" : "text-ink-faint",
                            )}
                          >
                            {l || " "}
                          </div>
                        ))}
                </pre>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
