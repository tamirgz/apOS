"use client";

import { Bot, User } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { shortDate } from "@/core/ui/time";
import type { WorkItem } from "../core";
import type { TaskPriority, TaskStatus } from "../schema";
import { PRIORITY_META, STATUS_META } from "../states";

/**
 * The small visual vocabulary shared by the board, list, timeline, My work and
 * the drawer: state and priority glyphs, label pills, the estimate box, the due
 * date, and the owner avatar. Styles live in work.css (theme tokens only).
 */

const DAY = 86_400_000;
export const isClosed = (s: TaskStatus) => s === "done" || s === "cancelled";

/** Linear-style state glyph: dashed ring → ring → half pie → ¾ pie → check. */
export function StateGlyph({ s, size = 14 }: { s: TaskStatus; size?: number }) {
  const c = STATUS_META[s].color;
  const label = STATUS_META[s].label;
  if (s === "backlog")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2 2" />
      </svg>
    );
  if (s === "todo")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
      </svg>
    );
  if (s === "done")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
        <circle cx="7" cy="7" r="6" fill={c} />
        <path d="M4.4 7.2l1.8 1.8 3.5-3.6" fill="none" stroke="var(--color-void)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (s === "cancelled")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
        <circle cx="7" cy="7" r="6" fill={c} />
        <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="var(--color-void)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  const frac = s === "doing" ? 0.5 : 0.75;
  const a = frac * 2 * Math.PI;
  const x = 7 + 4 * Math.sin(a);
  const y = 7 - 4 * Math.cos(a);
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
      <path d={`M7 7V3A4 4 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`} fill={c} />
    </svg>
  );
}

/** Priority as signal bars; urgent is a filled alert square. */
export function PriorityGlyph({ p, size = 14 }: { p: TaskPriority; size?: number }) {
  const label = `${PRIORITY_META[p].label} priority`;
  if (p === "urgent")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="var(--color-flare)" />
        <path d="M7 3.6v4.2M7 10.2v.2" stroke="var(--color-void)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const lit = p === "high" ? 3 : p === "medium" ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label} className="shrink-0">
      {[0, 1, 2].map((i) => {
        const h = 4 + i * 3.5;
        return (
          <rect
            key={i}
            x={1 + i * 4.5}
            y={13 - h}
            width="3"
            height={h}
            rx="1"
            fill={i < lit ? (p === "high" ? "var(--color-solar)" : "var(--color-ink-dim)") : "color-mix(in oklab, var(--color-ink) 14%, transparent)"}
          />
        );
      })}
    </svg>
  );
}

/** Stable colour per label, from the theme's accents (a few common names are pinned). */
const LABEL_PINNED: Record<string, string> = {
  bug: "var(--color-flare)",
  security: "var(--color-solar)",
  docs: "var(--color-ink-dim)",
  perf: "var(--color-ion)",
  agent: "var(--color-plasma)",
  ui: "var(--color-ion)",
  api: "var(--color-gold)",
};
const LABEL_PALETTE = ["var(--color-ion)", "var(--color-violet)", "var(--color-plasma)", "var(--color-solar)", "var(--color-orchid)", "var(--color-gold)"];
export function labelColor(l: string): string {
  const k = l.toLowerCase();
  if (LABEL_PINNED[k]) return LABEL_PINNED[k];
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[h % LABEL_PALETTE.length];
}

export function LabelPill({ l }: { l: string }) {
  const c = labelColor(l);
  return (
    <span className="wk-lbl" style={{ color: c, borderColor: `color-mix(in oklab, ${c} 40%, transparent)` }}>
      {l}
    </span>
  );
}

export function LabelPills({ labels, max = 3 }: { labels: string[]; max?: number }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <LabelPill key={l} l={l} />
      ))}
      {labels.length > max && <span className="wk-due">+{labels.length - max}</span>}
    </>
  );
}

export function Est({ n }: { n: number | null | undefined }) {
  if (n == null) return null;
  return (
    <span className="wk-est" title={`${n} point${n === 1 ? "" : "s"}`}>
      {n}
    </span>
  );
}

export type DueTone = "late" | "soon" | "ok";
export function dueTone(item: Pick<WorkItem, "dueAt" | "status">, now: number): DueTone | null {
  if (!item.dueAt) return null;
  if (isClosed(item.status)) return "ok";
  const days = Math.floor((+new Date(item.dueAt) - now) / DAY);
  return days < 0 ? "late" : days <= 2 ? "soon" : "ok";
}

export function Due({ item, now }: { item: Pick<WorkItem, "dueAt" | "status">; now: number }) {
  const tone = dueTone(item, now);
  if (!tone || !item.dueAt) return null;
  return (
    <span className={cn("wk-due", tone === "late" && "late", tone === "soon" && "soon")} title={`Due ${new Date(item.dueAt).toDateString()}`}>
      {shortDate(item.dueAt)}
    </span>
  );
}

/** Who owns the item: you, or a Workbench run it was handed to. */
export function Who({ bot, title }: { bot?: boolean; title?: string }) {
  return (
    <span className={cn("wk-who", bot ? "bot" : "me")} title={title ?? (bot ? "Handed to a Workbench run" : "You")}>
      {bot ? <Bot className="size-3" /> : <User className="size-3" />}
    </span>
  );
}

/** A delegated item counts as the bot's while its run is live. */
export const botOwned = (delegated: string | undefined) => !!delegated && delegated !== "done" && delegated !== "cancelled";

/** Suggested git branch for an item: "ethos-12-short-slug". */
export function branchName(identifier: string | null, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");
  return [identifier?.toLowerCase(), slug].filter(Boolean).join("-") || "work-item";
}

/**
 * Imported titles often lead with their own tag — "#AUTH-BOOTSTRAP — …" or
 * "E-144 — …". Cards show that tag as a quiet chip and the rest as the title,
 * so the words you scan come first. Markdown markers are already stripped.
 */
export function splitTitle(text: string): { tag: string | null; text: string } {
  const m = text.match(/^(#[\p{L}\p{N}][\p{L}\p{N}_.\-/]*|[A-Z][A-Z0-9]{0,7}-\d+)\s*[—–:-]\s+(.+)$/u);
  return m ? { tag: m[1].replace(/^#/, ""), text: m[2] } : { tag: null, text };
}

export function TitleTag({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <span className="max-w-full truncate rounded-md bg-ink/[0.06] px-1.5 py-px font-mono text-[10.5px] text-ink-faint" title={tag}>
      {tag}
    </span>
  );
}
