"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchSection } from "@/core/search/commandSearch";
import type { CommandSearchHit } from "@/core/search/types";
import { cn } from "./cn";

type Tab = { href: string; label: string };

/**
 * The nav sections that span several modules. Each page in a section shows the
 * same tab strip, so the section reads as one place (Library, Automation) while
 * every module keeps its own route.
 */
const SECTIONS: Record<string, { tabs: Tab[]; placeholder: string }> = {
  library: {
    tabs: [
      { href: "/m/notes", label: "Notes" },
      { href: "/m/ideas", label: "Ideas" },
      { href: "/m/knowledge", label: "Knowledge" },
      { href: "/m/vault", label: "Vault" },
      { href: "/m/orbit", label: "Orbit" },
    ],
    placeholder: "Search notes, ideas, knowledge & vault…",
  },
  automation: {
    tabs: [
      { href: "/m/workbench", label: "Runs" },
      { href: "/m/workbench/executors", label: "Executors" },
      { href: "/m/agents", label: "Agents" },
      { href: "/m/agents/models", label: "Agent models" },
      { href: "/m/studio", label: "Flows" },
    ],
    placeholder: "Search runs & agent reports…",
  },
};

const KIND_LABEL: Record<string, string> = {
  note: "note",
  idea: "idea",
  knowledge: "knowledge",
  vault: "vault",
  workbench: "run",
  report: "report",
};

/** Longest tab href that prefixes the path wins (so /m/agents/models beats /m/agents). */
function activeHref(tabs: Tab[], path: string): string | null {
  const hits = tabs.filter((t) => path === t.href || path.startsWith(`${t.href}/`));
  return hits.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function SectionTabs({ section }: { section: keyof typeof SECTIONS }) {
  const cfg = SECTIONS[section];
  const path = usePathname();
  const active = activeHref(cfg.tabs, path);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<(CommandSearchHit & { kind: string })[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Debounced lexical search; a stale reply never overwrites a newer query.
  useEffect(() => {
    const term = q.trim();
    let live = true;
    const t = setTimeout(() => {
      if (term.length < 2) return setHits([]);
      searchSection(section, term)
        .then((r) => live && setHits(r))
        .catch(() => live && setHits([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, section]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <nav className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-white/6 pb-3">
      {cfg.tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active === t.href ? "page" : undefined}
          className={cn(
            "rounded-lg px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
            active === t.href
              ? "bg-ion/15 text-ion"
              : "text-ink-faint hover:bg-white/5 hover:text-ink-dim",
          )}
        >
          {t.label}
        </Link>
      ))}
      <div ref={box} className="relative ml-auto w-full sm:w-72">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          placeholder={cfg.placeholder}
          className="h-8 w-full rounded-lg border border-white/6 bg-white/3 pl-8 pr-2 text-xs text-ink outline-none transition placeholder:text-ink-faint focus:border-ion/30"
        />
        {open && q.trim().length >= 2 && (
          <div className="glass absolute right-0 top-9 z-30 flex max-h-80 w-full flex-col overflow-y-auto rounded-xl p-1 sm:w-96">
            {hits.length === 0 ? (
              <p className="px-3 py-3 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                no matches
              </p>
            ) : (
              hits.map((h) => (
                <Link
                  key={h.id}
                  href={h.href}
                  onClick={() => setOpen(false)}
                  className="flex min-w-0 items-baseline gap-2 rounded-lg px-3 py-2 transition hover:bg-white/5"
                >
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ion">
                    {KIND_LABEL[h.kind] ?? h.kind}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{h.title}</span>
                    {h.subtitle && (
                      <span className="block truncate text-xs text-ink-faint">{h.subtitle}</span>
                    )}
                  </span>
                </Link>
              ))
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
