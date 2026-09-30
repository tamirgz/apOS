"use client";

import type { CycleSummary } from "../cycles";
import type { CycleMetrics } from "../stats";

const DAY = 86_400_000;

/** The progress segments every cycle view draws, in stacking order. */
export const SEGMENTS = [
  { status: "done", label: "done", color: "var(--color-plasma)" },
  { status: "review", label: "review", color: "var(--color-violet)" },
  { status: "doing", label: "doing", color: "var(--color-solar)" },
] as const;

/**
 * Remaining work per day against the ideal straight line, drawn to fill its
 * box. Scope added mid-cycle makes the line step UP — that's the point of it.
 */
export function Burn({ c, height = 46, className }: { c: CycleSummary; height?: number; className?: string }) {
  const days = Math.max(2, Math.round((+new Date(c.endsAt) - +new Date(c.startsAt)) / DAY) + 1);
  const pts = c.burndown;
  if (!pts.length) return <div style={{ height }} className={className} aria-hidden />;
  const top = Math.max(1, ...pts.map((p) => p.remaining));
  const W = 300;
  const H = height;
  const X = (i: number) => (i / (days - 1)) * W;
  const Y = (v: number) => 4 + (1 - v / top) * (H - 8);
  const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.remaining).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      className={`block w-full overflow-visible ${className ?? ""}`}
      role="img"
      aria-label={`Burndown: ${last.remaining} of ${top} items still open`}
    >
      {height >= 70 &&
        [0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={4 + f * (H - 8)}
            y2={4 + f * (H - 8)}
            stroke="color-mix(in oklab, var(--color-ion) 10%, transparent)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      <polyline
        points={`0,${Y(pts[0].remaining)} ${W},${Y(0)}`}
        fill="none"
        stroke="color-mix(in oklab, var(--color-ink) 22%, transparent)"
        strokeDasharray="3 3"
        strokeWidth="1.2"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={`0,${H} ${line} ${X(pts.length - 1)},${H}`} fill="color-mix(in oklab, var(--color-plasma) 14%, transparent)" />
      <polyline points={line} fill="none" stroke="var(--color-plasma)" strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(pts.length - 1)} cy={Y(last.remaining)} r="3" fill="var(--color-plasma)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The segmented done / review / doing bar with its legend. */
export function CycleBar({ m, big = false }: { m: CycleMetrics; big?: boolean }) {
  return (
    <>
      <div className={big ? "wk-bar !h-2.5" : "wk-bar"} role="img" aria-label={`${m.by.done} of ${m.total} ${m.unit} done`}>
        {m.total > 0 && SEGMENTS.map((s) => <b key={s.status} style={{ width: `${(m.by[s.status] / m.total) * 100}%`, background: s.color }} />)}
      </div>
      <div className="mt-[7px] flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-ink-dim">
        {SEGMENTS.map((s) => (
          <span key={s.status} className="inline-flex items-center gap-[5px]">
            <i className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
            {m.by[s.status]} {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-[5px]">
          <i className="inline-block size-2 rounded-[2px] bg-ink/20" />
          {m.by.todo} todo
        </span>
      </div>
    </>
  );
}
