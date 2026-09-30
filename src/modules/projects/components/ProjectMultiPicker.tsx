"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FolderKanban } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import type { ProjectOption } from "../queries";

/**
 * "File this under one or more projects/areas" picker. Multi-select: a button
 * that opens a grouped checklist (Areas of development vs Projects). Value is a
 * list of entity refs ("projects:<uuid>").
 *
 * The menu is portalled to <body> at coordinates measured from the button, so a
 * transformed/overflow-clipped ancestor (the Workbench detail header) can't
 * throw off its position.
 */
export function ProjectMultiPicker({
  options,
  value,
  onChange,
  className,
}: {
  options: ProjectOption[];
  value: string[];
  onChange: (refs: string[]) => void | Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const MENU_W = 256;

  const selectedIds = new Set(
    value.map((v) => (v.startsWith("projects:") ? v.slice("projects:".length) : v)),
  );
  const areas = options.filter((o) => o.kind === "area");
  const projects = options.filter((o) => o.kind === "project");
  const selectedNames = options.filter((o) => selectedIds.has(o.id)).map((o) => o.name);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Anchor the menu's left edge to the button; if the viewport is known and it
    // would overflow the right edge, shift it left so it stays on screen.
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    let left = r.left;
    if (vw && left + MENU_W + 8 > vw) left = Math.max(8, vw - MENU_W - 8);
    setCoords({ top: r.bottom + 4, left });
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        btnRef.current &&
        !btnRef.current.contains(t) &&
        menuRef.current &&
        !menuRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    // Scrolling INSIDE the menu list must not close it — only a PAGE scroll
    // should, and then we just re-anchor the fixed menu to the (moved) button.
    const onScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      place();
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = (id: string) => {
    const ref = `projects:${id}`;
    const next = selectedIds.has(id) ? value.filter((v) => v !== ref) : [...value, ref];
    start(async () => {
      await act(async () => onChange(next), { failed: "Couldn't update the projects" });
    });
  };

  const label =
    selectedNames.length === 0
      ? "file under…"
      : selectedNames.length === 1
        ? selectedNames[0]
        : `${selectedNames.length} filed`;

  // A render helper, not a component: a component declared in render is a new
  // type every render, so React would remount the whole checklist each time.
  const group = (heading: string, items: ProjectOption[]) => (
    <div className="mb-1 last:mb-0">
      <p className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">
        {heading}
      </p>
      {items.map((o) => {
        const on = selectedIds.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => toggle(o.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-dim transition hover:bg-white/6"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded border",
                on ? "border-plasma bg-plasma/25 text-plasma" : "border-white/15",
              )}
            >
              {on && <Check className="size-3" />}
            </span>
            <span className="truncate">{o.name}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={cn("inline-block", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        title="File this under one or more projects / areas of development"
        className={cn(
          "flex max-w-[240px] items-center gap-1.5 rounded-lg border border-white/10 bg-abyss/60 px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition hover:border-plasma/40",
          selectedNames.length ? "text-ink-dim" : "text-ink-faint",
          pending && "opacity-50",
        )}
      >
        <FolderKanban className="size-3 shrink-0 text-ink-faint" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-faint" />
      </button>

      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: coords.top, left: coords.left, width: MENU_W }}
            className="z-[100] max-h-80 overflow-auto rounded-lg border border-white/10 bg-abyss p-1 shadow-xl shadow-black/40"
          >
            {areas.length > 0 && group("Areas of development", areas)}
            {projects.length > 0 && group("Projects", projects)}
            {options.length === 0 && (
              <p className="px-2 py-2 text-xs text-ink-faint">No projects yet.</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
