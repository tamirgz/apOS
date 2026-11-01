import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/core/ui/cn";
import type { TimeboxKind } from "../schema";
import type { Gap } from "../timeline";
import { KIND_META } from "../timebox-kinds";

/**
 * The pieces of the day timeline, shared by the Plan screen, the Calendar
 * week and Today's Now strip: Google time hatched, boxes tinted by kind with a
 * kind/end chip, buffers and unboxed time dashed, a red now-line. Callers
 * position each piece (vertical columns or a horizontal ribbon).
 */

export const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (t: number | Date) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dur = (min: number) =>
  min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${pad(min % 60)}m` : ""}` : `${Math.round(min)}m`;

const SOURCE_LABEL = { google: "Google", ics: "Calendar", local: "apOS" } as const;

/** "DEEP · SOFT", "HARD", "INBOX · HARD" — or nothing for a plain soft personal box. */
export function chipFor(kind: TimeboxKind, endMode: "soft" | "hard"): string | null {
  const parts = [kind === "shallow" || kind === "personal" ? null : KIND_META[kind].label, kind === "personal" && endMode === "soft" ? null : endMode];
  return parts.filter(Boolean).join(" · ") || null;
}

/** Diagonal hatching for time someone else's calendar holds. */
export const HATCH =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--color-ink-faint) 30%, transparent) 0 6px, color-mix(in oklab, var(--color-ink-faint) 14%, transparent) 6px 12px)";

export const tint = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, var(--color-panel))`;

export function BusyBlock({
  title,
  start,
  end,
  source,
  tall = true,
  style,
  className,
}: {
  title: string;
  start: Date | number;
  end: Date | number;
  source: keyof typeof SOURCE_LABEL;
  tall?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const when = `${SOURCE_LABEL[source]} · ${hhmm(start)}–${hhmm(end)}`;
  return (
    <div
      title={`${title} · ${when}`}
      className={cn("overflow-hidden rounded-md border-l-[3px] border-ink-faint/60 px-2.5 text-ink-dim", tall ? "py-1" : "flex items-center gap-2", className)}
      style={{ background: HATCH, ...style }}
    >
      <span dir="auto" className={cn("truncate text-[13px] leading-tight", tall && "block")}>
        {title}
      </span>
      <span className={cn("truncate font-mono text-[10px] text-ink-dim/80", tall && "block")}>{when}</span>
    </div>
  );
}

export function BoxBlock({
  title,
  start,
  end,
  kind,
  endMode,
  draft,
  meta,
  tall = true,
  selected,
  style,
  className,
  children,
  ...rest
}: {
  title: string;
  start: Date | number;
  end: Date | number;
  kind: TimeboxKind;
  endMode: "soft" | "hard";
  draft?: boolean;
  /** Shown after the times on the second line, e.g. the project. */
  meta?: string | null;
  tall?: boolean;
  selected?: boolean;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  const color = KIND_META[kind].color;
  const chip = chipFor(kind, endMode);
  const time = `${hhmm(start)}–${hhmm(end)}`;
  const chips = (
    <>
      {chip && (
        <span
          className={cn(
            "shrink-0 rounded-[4px] border px-1.5 font-mono text-[9px] uppercase leading-[14px] tracking-wider",
            tall && "float-right mt-px ml-2",
          )}
          style={{ color, borderColor: `color-mix(in oklab, ${color} 70%, transparent)` }}
        >
          {chip}
        </span>
      )}
      {draft && (
        <span className={cn("shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint", tall && "float-right mt-px ml-2")}>
          draft
        </span>
      )}
    </>
  );
  return (
    <div
      {...rest}
      className={cn(
        "overflow-hidden rounded-md px-2.5 text-[13px] leading-tight text-ink",
        tall ? "py-1" : "flex items-center gap-2",
        selected && "ring-1 ring-white/60",
        className,
      )}
      style={{
        borderLeft: `3px solid ${color}`,
        background: tint(color, draft ? 13 : 17),
        outline: draft ? `1px dashed color-mix(in oklab, ${color} 55%, transparent)` : undefined,
        outlineOffset: -1,
        ...style,
      }}
    >
      {tall && chips}
      <span dir="auto" className={cn("truncate font-medium", tall ? "block" : "min-w-0 flex-1")}>
        {title}
      </span>
      <span className={cn("shrink-0 truncate font-mono text-[10px] text-ink-dim", tall && "block")}>
        {time}
        {meta ? ` · ${meta}` : ""}
      </span>
      {!tall && chips}
      {children}
    </div>
  );
}

/** Open time between things: a short dashed buffer, or the unboxed room left for the unexpected. */
export function GapBlock({ gap, style, className }: { gap: Gap; style?: CSSProperties; className?: string }) {
  const buffer = gap.kind === "buffer";
  return (
    <div
      className={cn(
        "pointer-events-none flex overflow-hidden rounded-md border border-dashed font-mono text-[10px] text-ink-faint",
        buffer ? "items-center border-white/8 px-2.5" : "items-center justify-center border-white/12",
        className,
      )}
      style={style}
    >
      <span className="truncate">{buffer ? `buffer ${dur(gap.minutes)}` : `unboxed ${dur(gap.minutes)} · room for the unexpected`}</span>
    </div>
  );
}

/** The red now-line with its dot; the caller sets `top` (or `left` for a ribbon). */
export function NowLine({ style, vertical }: { style?: CSSProperties; vertical?: boolean }) {
  return (
    <div
      className={cn("pointer-events-none absolute z-30 border-flare", vertical ? "top-0 bottom-0 border-l-2" : "right-0 border-t-2")}
      style={style}
    >
      <span className={cn("absolute size-2 rounded-full bg-flare", vertical ? "-top-1 -left-[5px]" : "-top-[5px] -left-1")} />
    </div>
  );
}

/** Free time, and how it's spent: boxed, buffers, unboxed — with the Draft-my-day cap marked. */
export function TimeBar({
  free,
  boxed,
  buffers,
  unboxed,
  cap,
  workEnd,
}: {
  free: number;
  boxed: number;
  buffers: number;
  unboxed: number;
  cap: number;
  workEnd: string;
}) {
  if (free === 0)
    return <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">no work time left before {workEnd}</p>;
  const pct = (n: number) => `${Math.min(100, (n / free) * 100)}%`;
  const over = boxed / free;
  return (
    <div title={`Free time before ${workEnd}. Draft my day boxes at most ${Math.round(cap * 100)}% of it.`}>
      <div className="mb-1.5 flex justify-between gap-4 font-mono text-[11px] text-ink-dim">
        <span>
          Free time <span className="text-ink">{dur(free)}</span>
          <span className="text-ink-faint"> · until {workEnd}</span>
        </span>
        <span className={cn(over > cap && "text-solar", over > 1 && "text-flare")}>
          Boxed {dur(boxed)} · buffers {dur(buffers)} · unboxed {dur(unboxed)}
        </span>
      </div>
      <div data-testid="capacity" className="relative flex h-2.5 overflow-hidden rounded-full bg-white/6">
        <i className={cn("block h-full transition-[width]", over > 1 ? "bg-flare" : over > cap ? "bg-solar" : "bg-violet")} style={{ width: pct(boxed) }} />
        <i className="block h-full bg-ink-faint/50" style={{ width: pct(buffers) }} />
        <span className="absolute top-0 h-full w-px bg-ink/70" style={{ left: `${cap * 100}%` }} />
      </div>
    </div>
  );
}
