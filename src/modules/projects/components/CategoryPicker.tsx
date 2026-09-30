"use client";

import { useState, useTransition } from "react";
import { Tag, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { categoryColor } from "./categoryColor";

export function CategoryPicker({
  id,
  category,
  categories,
  onSet,
}: {
  id: string;
  category: string | null;
  categories: string[];
  onSet: (id: string, category: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();

  const set = (value: string | null) => {
    setOpen(false);
    setDraft("");
    start(async () => {
      await act(() => onSet(id, value), { failed: "Couldn't set the category" });
    });
  };

  const suggestions = categories.filter((c) => c !== category);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest transition",
          pending && "opacity-50",
          category
            ? "text-ink-dim hover:bg-white/5"
            : "border-dashed border-white/15 text-ink-faint hover:text-ink-dim",
        )}
        style={category ? { borderColor: `color-mix(in oklab, ${categoryColor(category)} 45%, transparent)` } : undefined}
      >
        {category ? (
          <>
            <span className="size-1.5 rounded-full" style={{ background: categoryColor(category) }} />
            {category}
          </>
        ) : (
          <>
            <Tag className="size-2.5" /> category
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="glass absolute left-0 top-full z-20 mt-1 w-56 rounded-xl p-2">
            <div className="flex flex-wrap gap-1">
              {suggestions.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set(c)}
                  className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5"
                  style={{ borderColor: `color-mix(in oklab, ${categoryColor(c)} 40%, transparent)` }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: categoryColor(c) }} />
                  {c}
                </button>
              ))}
              {suggestions.length === 0 && (
                <span className="px-1 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                  no categories yet
                </span>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = draft.trim();
                if (v) set(v);
              }}
              className="mt-2 flex items-center gap-1 border-t border-white/6 pt-2"
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="New category…"
                className="h-7 flex-1 rounded-md bg-white/5 px-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
              />
              {category && (
                <button
                  type="button"
                  onClick={() => set(null)}
                  title="Clear category"
                  className="rounded-md p-1 text-ink-faint transition hover:bg-flare/10 hover:text-flare"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </form>
          </div>
        </>
      )}
    </div>
  );
}
