"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { BrainCircuit, Sparkles, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { categoryColor } from "@/modules/projects/components/categoryColor";
import { captureKnowledge } from "../actions";
import type { KnowledgeDuplicate } from "../dedup";
import type { KnowledgeItem } from "../schema";
import { KIND_META, STATUS_META } from "./kindMeta";

function CaptureBox() {
  const [pending, startTransition] = useTransition();
  const [dup, setDup] = useState<KnowledgeDuplicate | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = inputRef.current?.value.trim();
        if (!value || pending) return;
        setDup(null);
        startTransition(async () => {
          const res = await captureKnowledge(value, noteRef.current?.value);
          if (res.duplicate) {
            // Already saved — surface the existing item, keep the input.
            setDup(res.item);
            return;
          }
          if (inputRef.current) inputRef.current.value = "";
          if (noteRef.current) noteRef.current.value = "";
        });
      }}
      className="glass mb-4 rounded-2xl p-3 focus-within:glass-edge"
    >
      <div className="flex items-start gap-3">
        <BrainCircuit className="mt-1 size-5 shrink-0 text-orchid" />
        <textarea
          ref={inputRef}
          rows={2}
          onKeyDown={(e) => {
            // Paste-and-move-on: Enter submits, Shift+Enter makes a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Paste anything — a GitHub repo, Instagram/TikTok link, a quote, an idea…"
          className="min-h-10 flex-1 resize-y bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          disabled={pending}
        />
      </div>
      <div className="mt-2 flex items-center gap-3 border-t border-white/5 pt-3">
        <input
          ref={noteRef}
          placeholder="Why is this interesting? (optional — guides the AI analysis)"
          className="h-8 flex-1 bg-transparent text-xs text-ink-dim outline-none placeholder:text-ink-faint"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-orchid/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-orchid transition hover:bg-orchid/25 disabled:opacity-40"
        >
          <Sparkles className="size-3.5" />
          {pending ? "capturing…" : "capture"}
        </button>
      </div>
      {dup && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-solar/25 bg-solar/8 px-3 py-2 text-xs text-ink-dim">
          <span className="text-solar">Already captured —</span>
          <Link
            href={`/m/knowledge/${dup.id}`}
            className="truncate font-medium text-ink underline decoration-solar/40 underline-offset-2 hover:decoration-solar"
          >
            {dup.title ?? dup.input.slice(0, 80)}
          </Link>
          <button
            type="button"
            onClick={() => setDup(null)}
            className="ml-auto shrink-0 rounded p-0.5 text-ink-faint transition hover:text-ink"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </form>
  );
}

function ItemCard({ item, index }: { item: KnowledgeItem; index: number }) {
  const kind = KIND_META[item.kind];
  const status = STATUS_META[item.status];
  const Icon = kind.icon;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{
        type: "spring",
        stiffness: 380,
        damping: 32,
        delay: index * 0.03,
      }}
    >
      <Link
        href={`/m/knowledge/${item.id}`}
        className="glass block h-full rounded-xl p-4 transition hover:bg-white/4"
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon className="size-4" style={{ color: kind.color }} />
          <span
            className="font-mono text-[9px] uppercase tracking-[0.25em]"
            style={{ color: kind.color }}
          >
            {kind.label}
          </span>
          <span
            className={cn(
              "ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest",
              status.pulse && "animate-pulse-soft",
            )}
            style={{ color: status.color }}
          >
            <span className="dot" style={{ color: status.color }} />
            {status.label}
          </span>
        </div>
        <p className="line-clamp-2 text-sm leading-snug text-ink">
          {item.title ?? item.input}
        </p>
        {item.insight?.summary && (
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">
            {item.insight.summary}
          </p>
        )}
        {item.insight?.tags && item.insight.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {item.insight.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-md border border-orchid/20 bg-orchid/5 px-1.5 py-0.5 font-mono text-[9px] text-orchid"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </Link>
    </motion.div>
  );
}

const UNSORTED = "Unsorted";

/** Group items by their theme category; Unsorted (unclassified) sinks last,
 *  the rest by size so the fullest shelves lead. */
function groupByCategory(
  items: KnowledgeItem[],
): [string, KnowledgeItem[]][] {
  const map = new Map<string, KnowledgeItem[]>();
  for (const it of items) {
    const c = it.category?.trim() || UNSORTED;
    const bucket = map.get(c) ?? (map.set(c, []), map.get(c)!);
    bucket.push(it);
  }
  return [...map.entries()].sort((a, b) => {
    if (a[0] === UNSORTED) return 1;
    if (b[0] === UNSORTED) return -1;
    return b[1].length - a[1].length;
  });
}

function FilterPill({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
        active
          ? "border-white/20 bg-white/6 text-ink"
          : "border-white/8 text-ink-dim hover:bg-white/4",
      )}
    >
      <span
        className="size-1.5 rounded-full"
        style={color ? { background: color } : { border: "1px solid rgba(255,255,255,0.25)" }}
      />
      <span className="max-w-[12rem] truncate">{label}</span>
      <span className="font-mono text-[10px] text-ink-faint">{count}</span>
    </button>
  );
}

function SectionHeader({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string | null;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span
        className="size-2 rounded-full"
        style={color ? { background: color } : { border: "1px solid rgba(255,255,255,0.2)" }}
      />
      <h3 className="font-display text-sm font-semibold text-ink">{label}</h3>
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {count}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-white/8 to-transparent" />
    </div>
  );
}

export function KnowledgeBoard({ items }: { items: KnowledgeItem[] }) {
  useLiveEvents(["knowledge_changed"]);
  // Filter to one category, or null for all. Searching lives in ⌘K.
  const [active, setActive] = useState<string | null>(null);
  const groups = useMemo(() => groupByCategory(items), [items]);
  const shown = active ? groups.filter(([c]) => c === active) : groups;

  return (
    <div>
      <CaptureBox />
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-16 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
            nothing captured yet — paste something interesting above
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <FilterPill
              label="All"
              count={items.length}
              color={null}
              active={active === null}
              onClick={() => setActive(null)}
            />
            {groups.map(([cat, list]) => (
              <FilterPill
                key={cat}
                label={cat}
                count={list.length}
                color={cat === UNSORTED ? null : categoryColor(cat)}
                active={active === cat}
                onClick={() => setActive(active === cat ? null : cat)}
              />
            ))}
          </div>
          <div className="flex flex-col gap-8">
            {shown.map(([cat, list]) => (
              <section key={cat}>
                <SectionHeader
                  label={cat}
                  count={list.length}
                  color={cat === UNSORTED ? null : categoryColor(cat)}
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <AnimatePresence mode="popLayout">
                    {list.map((item, i) => (
                      <ItemCard key={item.id} item={item} index={i} />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
