"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/core/ui/cn";
import type { DecisionView } from "../decisions";

const who = (by: string) => by.replace(/^agent:/, "").replace(/#\w+$/, "");
const day = (d: Date) => new Date(d).toISOString().slice(0, 16).replace("T", " ");

/**
 * A project's decisions — the user's answers that agents record through the
 * decisions.* tools. Read-only: newest first, filtered by text or item, with
 * superseded decisions hidden unless asked for.
 */
export function ProjectDecisions({ decisions }: { decisions: DecisionView[] }) {
  const [q, setQ] = useState("");
  const [superseded, setSuperseded] = useState(false);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return decisions.filter(
      (d) =>
        (superseded || !d.supersededBy) &&
        (!needle ||
          [d.ref, d.question, d.answer, d.notes ?? "", ...d.items].some((s) => s.toLowerCase().includes(needle))),
    );
  }, [decisions, q, superseded]);

  if (!decisions.length) {
    return (
      <section className="glass rounded-2xl p-8 text-center text-sm text-ink-faint">
        No decisions yet. Agents record the user&apos;s decisions here — question, answer, notes, when and the items they
        concern — with the <span className="font-mono text-ink-dim">decisions.record</span> tool.
      </section>
    );
  }

  const hidden = decisions.filter((d) => d.supersededBy).length;
  return (
    <section aria-label="Decisions" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="glass flex min-w-[240px] flex-1 items-center gap-2 rounded-xl px-3 py-2">
          <Search className="size-3.5 text-ink-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by text or item (ES-217)…"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        {hidden > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-ink-dim">
            <input type="checkbox" checked={superseded} onChange={(e) => setSuperseded(e.target.checked)} />
            Show {hidden} superseded
          </label>
        )}
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {shown.length} of {decisions.length}
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        {shown.map((d) => (
          <li key={d.ref} className={cn("glass flex flex-col gap-1.5 rounded-2xl p-4", d.supersededBy && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-faint">
              <span className="wk-chip">{d.ref}</span>
              <span suppressHydrationWarning>{day(d.decidedAt)} UTC</span>
              {d.items.map((i) => (
                <span key={i} className="wk-chip text-ink-dim">
                  {i}
                </span>
              ))}
              {d.supersededBy && <span className="wk-chip text-solar">superseded by {d.supersededBy}</span>}
              <span className="ml-auto truncate">{who(d.recordedBy)}</span>
            </div>
            <p className="text-[13px] text-ink-dim">
              <span className="font-mono text-ink-faint">Q </span>
              {d.question}
            </p>
            <p className="text-[14px] font-medium text-ink">
              <span className="font-mono text-plasma">A </span>
              {d.answer}
            </p>
            {d.notes && <p className="whitespace-pre-wrap text-[12px] text-ink-faint">{d.notes}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
