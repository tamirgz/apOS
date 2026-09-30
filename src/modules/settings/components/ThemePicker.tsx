"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { THEMES, type ThemeDef } from "@/core/theme";
import { saveTheme } from "../actions";

/** Apply a theme to <html> immediately (instant preview before it persists). */
function applyTheme(t: ThemeDef) {
  const root = document.documentElement;
  if (t.attr) root.setAttribute("data-theme", t.attr);
  else root.removeAttribute("data-theme");
}

export function ThemePicker({ current }: { current: string }) {
  const [selected, setSelected] = useState(current);
  const [pending, start] = useTransition();

  const pick = (t: ThemeDef) => {
    const prev = THEMES.find((x) => x.id === selected);
    setSelected(t.id);
    applyTheme(t); // instant
    start(async () => {
      // persist (SSR uses it next load); on failure, put the old look back
      const r = await act(() => saveTheme(t.id), { failed: "Couldn't save the theme" });
      if (!r.ok && prev) {
        setSelected(prev.id);
        applyTheme(prev);
      }
    });
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="font-display text-lg font-semibold text-ink">Theme</h2>
        <p className="text-sm text-ink-dim">
          Pick a look. Applies instantly and is saved for next time.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {THEMES.map((t) => {
          const active = selected === t.id;
          const [bg, surface, a1, a2] = t.swatch;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t)}
              disabled={pending && active}
              className={cn(
                "group relative flex flex-col gap-3 rounded-xl border p-3 text-left transition",
                active
                  ? "border-plasma/50 bg-plasma/5"
                  : "border-white/8 hover:border-white/16 hover:bg-white/4",
              )}
            >
              {/* mini preview */}
              <div
                className="relative h-20 overflow-hidden rounded-lg border border-white/8"
                style={{ background: bg }}
              >
                <div
                  className="absolute left-3 top-3 h-11 w-24 rounded-md border"
                  style={{ background: surface, borderColor: "rgba(255,255,255,0.08)" }}
                />
                <div
                  className="absolute right-3 top-4 size-3 rounded-full"
                  style={{ background: a1, boxShadow: `0 0 10px 1px ${a1}` }}
                />
                <div
                  className="absolute bottom-3 right-3 h-2 w-10 rounded-full"
                  style={{ background: a2 }}
                />
                <div
                  className="absolute bottom-4 left-4 h-1.5 w-16 rounded-full"
                  style={{ background: a1, opacity: 0.7 }}
                />
              </div>

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{t.label}</span>
                    {active && (
                      <span className="flex items-center gap-1 rounded-md bg-plasma/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-plasma">
                        <Check className="size-2.5" />
                        {pending ? "saving" : "active"}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-snug text-ink-dim">{t.tagline}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
