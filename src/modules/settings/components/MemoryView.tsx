"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useNow } from "@/core/ui/useNow";
import { ArrowDown, ArrowUp, Search, Trash2, X } from "lucide-react";
import type { MemoryBlock } from "@/core/db/schema/memory";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { forgetMemoryEntryAction, lensMemory } from "../actions";
import { AddBlock, BlockField } from "./MemoryEditor";

export interface ArchiveEntry {
  id: string;
  kind: string;
  source: string;
  text: string;
  createdAt: string;
}

const DAY = 86_400_000;
const PALETTE = ["--color-plasma", "--color-ion", "--color-violet", "--color-solar", "--color-orchid", "--color-gold", "--color-flare"];
// Rewritten by the weekly consolidation, so age = staleness. current_focus is
// the user's own words — its age says nothing.
const WEEKLY = ["active_projects"];
const LANES: [string, string[]][] = [
  ["procedural", ["lesson", "policy"]],
  ["semantic", ["fact", "decision"]],
  ["episodic", ["event", "superseded"]],
];
const SOURCES: Record<string, { label: string; color: string }> = {
  "agent-run": { label: "agent self-lessons", color: "var(--color-violet)" },
  distill: { label: "weekly consolidation", color: "var(--color-plasma)" },
  block: { label: "replaced core value", color: "var(--color-ion)" },
  chat: { label: "you, in chat", color: "var(--color-solar)" },
};
const srcOf = (source: string) => source.split(":")[0];
const colorOf = (source: string) => SOURCES[srcOf(source)]?.color ?? "var(--color-ink-dim)";
const ageDays = (d: Date | string, now: number) => Math.floor((now - new Date(d).getTime()) / DAY);
const ago = (d: Date | string, now: number) => {
  const a = ageDays(d, now);
  return a === 0 ? "today" : `${a}d ago`;
};

function Layer({ n, tone, title, children }: { n: number; tone: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: tone }}>
        Layer {n} · {title}
      </span>
      {children}
    </div>
  );
}

function Flow({ items }: { items: { up?: boolean; down?: boolean; text: string }[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((f) => (
        <span
          key={f.text}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-dashed border-ion/25 bg-abyss/60 px-3 py-1 font-mono text-[11px]",
            f.up ? "text-plasma" : f.down ? "text-violet" : "text-ink-dim",
          )}
        >
          {f.up && <ArrowUp className="size-3" />}
          {f.down && <ArrowDown className="size-3" />}
          {f.text}
        </span>
      ))}
    </div>
  );
}

/* ── Layer 1 ─────────────────────────────────────────────────────────── */

function CoreBand({ blocks, injected, budget, protectedLabels, now }: { blocks: MemoryBlock[]; injected: number; budget: number; protectedLabels: string[]; now: number }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const tinted = blocks.map((b, i) => ({ b, tone: `var(${PALETTE[i % PALETTE.length]})` }));
  const oneOff = (b: MemoryBlock) =>
    !protectedLabels.includes(b.label) && (/\d{4}_\d\d_\d\d/.test(b.label) || ageDays(b.updatedAt, now) > 14);
  const oneOffChars = blocks.filter((b) => oneOff(b)).reduce((n, b) => n + b.value.trim().length, 0);
  const editing = blocks.find((b) => b.label === open);

  return (
    <section aria-label="Core blocks" className="glass grid gap-5 rounded-2xl p-5 md:grid-cols-[180px_1fr]">
      <Layer n={1} tone="var(--color-plasma)" title="always in mind">
        <h2 className="font-display text-lg text-ink">Core blocks</h2>
        <p className="text-[12.5px] leading-snug text-ink-dim">Sent with every chat and agent call.</p>
        <p className="mt-1">
          <span className="font-display text-[28px] leading-none tabular-nums text-ink">{injected.toLocaleString()}</span>
          <span className="font-mono text-xs text-ink-faint"> / {budget.toLocaleString()} chars</span>
        </p>
      </Layer>
      <div className="min-w-0">
        <div className="flex h-5 overflow-hidden rounded-md border border-ion/10 bg-white/[0.04]" role="img" aria-label={`${injected} of ${budget} characters used`}>
          {tinted
            .filter(({ b }) => b.value.trim())
            .map(({ b, tone }) => (
              <i
                key={b.label}
                title={`${b.label} · ${b.value.trim().length} chars`}
                className="block h-full border-r border-void"
                style={{ width: `${(b.value.trim().length / budget) * 100}%`, background: tone }}
              />
            ))}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-faint">
          <span>0</span>
          {oneOffChars > 0 && <span className="text-solar">{Math.round((oneOffChars / Math.max(injected, 1)) * 100)}% held by one-off blocks</span>}
          <span>{budget.toLocaleString()} · cap</span>
        </div>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2.5">
          {tinted.map(({ b, tone }) => {
            const used = b.value.trim().length;
            const flag = !used
              ? { t: "empty", c: "text-solar border-solar/35 bg-solar/10" }
              : oneOff(b)
                ? { t: "one-off", c: "text-flare border-flare/35 bg-flare/10" }
                : WEEKLY.includes(b.label) && ageDays(b.updatedAt, now) >= 9
                  ? { t: "stale", c: "text-solar border-solar/35 bg-solar/10" }
                  : null;
            return (
              <button
                key={b.label}
                type="button"
                onClick={() => setOpen(open === b.label ? null : b.label)}
                aria-expanded={open === b.label}
                className={cn(
                  "flex min-w-0 flex-col gap-1.5 rounded-xl border bg-white/[0.015] px-3 py-2.5 text-left transition hover:border-ion/30",
                  open === b.label ? "border-plasma/40" : "border-ion/10",
                )}
              >
                <span className="flex min-w-0 items-center gap-2 font-mono text-[12px] text-ink">
                  <i className="size-2 shrink-0 rounded-[3px]" style={{ background: tone }} />
                  <span className="truncate" title={b.label}>{b.label}</span>
                  {flag && <span className={cn("ml-auto shrink-0 rounded-md border px-1.5 text-[10px]", flag.c)}>{flag.t}</span>}
                </span>
                <span className="h-1 rounded-full bg-white/[0.06]">
                  <i className="block h-full rounded-full" style={{ width: `${Math.min(100, (used / b.charLimit) * 100)}%`, background: tone }} />
                </span>
                <span className="flex justify-between font-mono text-[11px] text-ink-faint">
                  <span className="tabular-nums">{used} / {b.charLimit}</span>
                  <span>{ago(b.updatedAt, now)}</span>
                </span>
              </button>
            );
          })}
        </div>
        {editing && (
          <div className="mt-3">
            <BlockField
              key={editing.label}
              block={editing}
              onDelete={protectedLabels.includes(editing.label) ? undefined : () => { setOpen(null); router.refresh(); }}
            />
          </div>
        )}
        <div className="mt-3"><AddBlock /></div>
      </div>
    </section>
  );
}

/* ── Layer 2 ─────────────────────────────────────────────────────────── */

const W = 900, X0 = 120, X1 = 890, LANE_H = 64, GAP = 8;

function ArchiveBand({ entries, now }: { entries: ArchiveEntry[]; now: number }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const { t0, t1, months, dots } = useMemo(() => {
    const times = entries.map((e) => new Date(e.createdAt).getTime());
    const end = now;
    const start = Math.min(end - 30 * DAY, ...times) - 3 * DAY;
    const x = (t: number) => X0 + ((t - start) / (end - start)) * (X1 - X0);
    const ms: { x: number; label: string }[] = [];
    for (let d = new Date(start); d.getTime() < end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const m = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      if (m.getTime() < end) ms.push({ x: x(m.getTime()), label: m.toLocaleString("en", { month: "short" }) });
    }
    const out: { e: ArchiveEntry; cx: number; cy: number }[] = [];
    LANES.forEach(([, kinds], li) => {
      const y0 = li * (LANE_H + GAP);
      const stack: Record<number, number> = {};
      for (const e of entries.filter((r) => kinds.includes(r.kind))) {
        const cx = x(new Date(e.createdAt).getTime());
        const col = Math.round(cx / 7);
        const n = (stack[col] = (stack[col] ?? 0) + 1) - 1;
        out.push({ e, cx: cx + Math.floor(n / 7) * 3, cy: y0 + LANE_H - 8 - (n % 7) * 7 });
      }
    });
    return { t0: start, t1: end, months: ms, dots: out };
  }, [entries, now]);
  const sel = entries.find((e) => e.id === picked);
  const counts = entries.reduce<Record<string, number>>((m, e) => ((m[srcOf(e.source)] = (m[srcOf(e.source)] ?? 0) + 1), m), {});
  const H = LANES.length * (LANE_H + GAP) + 18;

  return (
    <section aria-label="Archive" className="glass grid gap-5 rounded-2xl p-5 md:grid-cols-[180px_1fr]">
      <Layer n={2} tone="var(--color-violet)" title="recalled when relevant">
        <h2 className="font-display text-lg text-ink">Archive</h2>
        <p className="text-[12.5px] leading-snug text-ink-dim">Facts, decisions, lessons and events. A call pulls in the closest few.</p>
        <p className="mt-1">
          <span className="font-display text-[28px] leading-none tabular-nums text-ink">{entries.length}</span>
          <span className="font-mono text-xs text-ink-faint"> entries</span>
        </p>
      </Layer>
      <div className="min-w-0">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Archive timeline, ${entries.length} entries from ${new Date(t0).toLocaleDateString()} to ${new Date(t1).toLocaleDateString()}`}>
          {LANES.map(([tier, kinds], li) => {
            const y0 = li * (LANE_H + GAP);
            return (
              <g key={tier}>
                <rect x={0} y={y0} width={W} height={LANE_H} rx={10} fill="rgba(255,255,255,0.02)" />
                <text x={12} y={y0 + 24} fontSize={12.5} className="fill-ink font-mono">{tier}</text>
                <text x={12} y={y0 + 42} fontSize={10.5} className="fill-ink-faint font-mono">
                  {kinds.map((k) => `${k} ${entries.filter((e) => e.kind === k).length}`).join(" · ")}
                </text>
              </g>
            );
          })}
          {months.map((m) => (
            <g key={m.label + m.x}>
              <line x1={m.x} x2={m.x} y1={0} y2={H - 18} stroke="rgba(125,211,252,0.1)" />
              <text x={m.x + 4} y={H - 4} fontSize={11} className="fill-ink-faint font-mono">{m.label}</text>
            </g>
          ))}
          {dots.map(({ e, cx, cy }) => (
            <circle
              key={e.id}
              cx={cx}
              cy={cy}
              r={picked === e.id ? 4.5 : 2.8}
              style={{ fill: colorOf(e.source), cursor: "pointer" }}
              stroke={picked === e.id ? "var(--color-ink)" : "none"}
              onClick={() => { setPicked(e.id); setArmed(false); }}
            >
              <title>{`${e.kind} · ${e.source} · ${new Date(e.createdAt).toLocaleDateString()}\n${e.text}`}</title>
            </circle>
          ))}
        </svg>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
          {Object.entries(SOURCES).map(([k, s]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <i className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label} {counts[k] ?? 0}
            </span>
          ))}
          <span className="ml-auto">click a dot to read it</span>
        </div>
        {sel && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-ion/15 bg-abyss/50 p-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] text-ink-faint">
                <span style={{ color: colorOf(sel.source) }}>{sel.kind}</span> · {sel.source} · {new Date(sel.createdAt).toLocaleDateString()}
              </p>
              <p dir="auto" className="mt-1 text-[13px] leading-relaxed text-ink">{sel.text}</p>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                armed
                  ? startTransition(async () => {
                      const r = await act(() => forgetMemoryEntryAction(sel.id), { failed: "Couldn't forget the entry" });
                      if (r.ok) { setPicked(null); router.refresh(); }
                    })
                  : setArmed(true)
              }
              title="Delete this memory — recall stops finding it"
              className={cn("wk-btn shrink-0 !gap-1 !px-2 !py-0.5 text-[11.5px]", armed ? "!border-flare/50 text-flare" : "text-ink-faint hover:text-flare")}
            >
              <Trash2 className="size-3" /> {armed ? "Click again to forget" : "Forget"}
            </button>
            <button type="button" onClick={() => setPicked(null)} aria-label="Close" className="text-ink-faint hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ── Layer 3 + Lens ──────────────────────────────────────────────────── */

const LIBRARY = [
  { kind: "vault", label: "Obsidian vault", tone: "var(--color-ion)", href: "/m/vault" },
  { kind: "knowledge", label: "Knowledge", tone: "var(--color-violet)", href: "/m/knowledge" },
  { kind: "note", label: "Notes", tone: "var(--color-solar)", href: "/m/notes" },
];

type LensResult = Awaited<ReturnType<typeof lensMemory>>;

function Lens({ blocks, injected }: { blocks: MemoryBlock[]; injected: number }) {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [res, setRes] = useState<LensResult | null>(null);
  const [pending, startTransition] = useTransition();
  const filled = blocks.filter((b) => b.value.trim());
  const run = () => {
    const question = q.trim();
    if (question.length < 3 || pending) return;
    startTransition(async () => {
      const r = await act(() => lensMemory(question), { failed: "Couldn't look that up" });
      if (r.ok) { setRes(r.value); setAsked(question); }
    });
  };
  const col = "flex min-w-0 flex-col gap-2 rounded-xl border border-ion/10 p-3";
  const hit = "border-l-2 border-ion/15 pl-2 text-[12.5px] leading-snug text-ink-dim";
  return (
    <section aria-label="Lens" className="glass flex flex-col gap-3 rounded-2xl p-5">
      <form
        onSubmit={(e) => { e.preventDefault(); run(); }}
        className="flex items-center gap-3 rounded-xl border border-plasma/30 bg-plasma/[0.04] px-3.5 py-2"
      >
        <span className="font-mono text-[11px] tracking-[0.16em] text-plasma">LENS</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Ask the memory"
          placeholder="Ask anything to see what the model would get, e.g. how should project health be judged"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <button type="submit" disabled={pending || q.trim().length < 3} className="wk-btn !gap-1 !px-2.5 !py-1 text-xs">
          <Search className="size-3.5" /> {pending ? "Looking…" : "Look"}
        </button>
      </form>
      {res ? (
        <>
          <p className="font-mono text-[11px] text-ink-faint">What the model would receive for “{asked}”</p>
          <div className="grid gap-3 md:grid-cols-3">
            <div className={col}>
              <h4 className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-plasma">Layer 1 · always</h4>
              <p className={hit}>
                <span className="block font-mono text-[10.5px] text-ink-faint">{filled.length} blocks · {injected.toLocaleString()} chars</span>
                {filled.map((b) => b.label).join(", ")}
              </p>
              <p className="text-[11.5px] text-ink-faint">Sent every time, whatever the question.</p>
            </div>
            <div className={col}>
              <h4 className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-violet">Layer 2 · recalled</h4>
              {res.recall.length ? res.recall.map((r, i) => (
                <p key={i} dir="auto" className={hit}>
                  <span className="block font-mono text-[10.5px] text-ink-faint">{r.kind} · {r.source}</span>
                  {r.text}
                </p>
              )) : <p className="text-[12px] text-ink-faint">Nothing close enough.</p>}
            </div>
            <div className={col}>
              <h4 className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ion">Layer 3 · searched</h4>
              {res.library.length ? res.library.map((r, i) => {
                const body = (
                  <>
                    <span className="block font-mono text-[10.5px] text-ink-faint">{r.kind}</span>
                    {r.text.replace(/[#*]/g, "")}
                  </>
                );
                return r.href ? (
                  <Link key={i} href={r.href} dir="auto" className={cn(hit, "transition hover:text-ink")}>{body}</Link>
                ) : (
                  <p key={i} dir="auto" className={hit}>{body}</p>
                );
              }) : <p className="text-[12px] text-ink-faint">Nothing close enough.</p>}
            </div>
          </div>
        </>
      ) : (
        <p className="text-[12.5px] text-ink-faint">The Lens runs the same lookups chat and agents do, on local embeddings, so it costs nothing.</p>
      )}
    </section>
  );
}

export function MemoryView({
  blocks,
  entries,
  library,
  injected,
  budget,
  protectedLabels,
}: {
  blocks: MemoryBlock[];
  entries: ArchiveEntry[];
  library: Record<string, number>;
  injected: number;
  budget: number;
  protectedLabels: string[];
}) {
  const now = useNow();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-2xl tracking-wide text-ink">What apOS remembers</h1>
        <p className="mt-1 max-w-[70ch] text-[13.5px] text-ink-dim">
          Three layers, ordered by how close they sit to the model. The pills between them are the jobs that move memory from one layer to another.
        </p>
      </div>
      <CoreBand blocks={blocks} injected={injected} budget={budget} protectedLabels={protectedLabels} now={now} />
      <Flow items={[{ down: true, text: "a replaced block value is archived as “superseded”" }, { up: true, text: "Sunday 20:00 · consolidation distills the archive into core blocks" }]} />
      <ArchiveBand entries={entries} now={now} />
      <Flow items={[{ up: true, text: "after every agent run · a one-line self-lesson" }, { text: "03:30 nightly · prune old events, merge duplicates" }]} />
      <section aria-label="Your library" className="glass grid gap-5 rounded-2xl p-5 md:grid-cols-[180px_1fr]">
        <Layer n={3} tone="var(--color-ion)" title="searched on demand">
          <h2 className="font-display text-lg text-ink">Your library</h2>
          <p className="text-[12.5px] leading-snug text-ink-dim">Your own material, not agent-written. It&apos;s searched alongside the archive.</p>
        </Layer>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {LIBRARY.map((l) => (
            <Link key={l.kind} href={l.href} className="flex flex-col gap-1 rounded-xl border border-ion/10 px-4 py-3 transition hover:border-ion/30">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em]" style={{ color: l.tone }}>{l.label}</span>
              <span className="font-display text-[26px] leading-none tabular-nums text-ink">{library[l.kind] ?? 0}</span>
              <span className="text-[11.5px] text-ink-faint">documents searchable</span>
            </Link>
          ))}
        </div>
      </section>
      <Lens blocks={blocks} injected={injected} />
    </div>
  );
}
