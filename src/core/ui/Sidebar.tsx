"use client";

/* eslint-disable react-hooks/set-state-in-effect -- the group-open sync and
   badge load are deliberate post-render effects keyed on route/SSE changes. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { ArrowUpRight, ChevronRight, LayoutGrid } from "lucide-react";
import { navModules } from "@/modules/registry";
import type { ModuleManifest } from "@/core/modules/types";
import { getSidebarBadges } from "./sidebar-badges";
import { useLiveEvents } from "./useLiveEvents";
import { cn } from "./cn";

function NavItem({
  href,
  title,
  accent,
  icon: Icon,
  active,
  external = false,
  badge = 0,
}: {
  href: string;
  title: string;
  accent: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  active: boolean;
  /** A pointer-out (opens the real app) — shows an ↗ cue. */
  external?: boolean;
  /** Items waiting inside — rendered as a small count on the right. */
  badge?: number;
}) {
  return (
    <Link href={href} className="group relative block">
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-xl glass-edge bg-white/2"
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
        />
      )}
      <span
        className={cn(
          "relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
          active ? "text-ink" : "text-ink-dim hover:text-ink hover:bg-white/3",
        )}
      >
        <Icon
          className="size-4.5 shrink-0 transition-transform group-hover:scale-110"
          style={active ? { color: accent, filter: `drop-shadow(0 0 6px ${accent})` } : undefined}
        />
        <span className="font-display tracking-wide">{title}</span>
        {badge > 0 ? (
          <span className="ml-auto rounded-md bg-solar/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums leading-none text-solar">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : external ? (
          <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-ink-faint transition group-hover:text-ink-dim" />
        ) : active ? (
          <span className="dot ml-auto animate-pulse-soft" style={{ color: accent }} />
        ) : null}
      </span>
    </Link>
  );
}

/** True when the current route lives inside one of `items`. */
function isActiveModule(pathname: string, id: string): boolean {
  return pathname === `/m/${id}` || pathname.startsWith(`/m/${id}/`);
}

/**
 * A collapsible sidebar section (e.g. "Sources" — the read-only external feeds).
 * Collapsed by default; the header toggles it and nothing else overrides that.
 * When it's collapsed but one of its items is the current route, the header
 * shows a small active dot so you still know you're "in" a Source without the
 * drawer forcing itself open.
 */
function NavGroup({
  label,
  items,
  pathname,
}: {
  label: string;
  items: ModuleManifest[];
  pathname: string;
}) {
  const activeInside = items.some((m) => isActiveModule(pathname, m.id));
  // Collapsed by default — but when the current route already lives inside the
  // group, start open so the sidebar shows where you are. The header toggle
  // still rules after that.
  const [open, setOpen] = useState(activeInside);
  // Navigating INTO the group (sidebar persists across routes) opens it once;
  // collapsing it again while inside is respected — this only fires on the
  // outside→inside transition.
  useEffect(() => {
    if (activeInside) setOpen(true);
  }, [activeInside]);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-ink-faint transition hover:text-ink-dim"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em]">{label}</span>
        {activeInside && !open && (
          <span className="dot ml-1.5 text-plasma animate-pulse-soft" />
        )}
        <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-faint/70">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {items.map((m) => (
            <NavItem
              key={m.id}
              href={`/m/${m.id}`}
              title={m.title}
              accent={m.accent}
              icon={m.icon}
              active={isActiveModule(pathname, m.id)}
              external={m.nav.external}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [badges, setBadges] = useState<{ needsYou: number; inbox: number }>({
    needsYou: 0,
    inbox: 0,
  });
  const loadBadges = useCallback(() => {
    getSidebarBadges()
      .then(setBadges)
      .catch(() => {});
  }, []);
  useEffect(loadBadges, [loadBadges]);
  useLiveEvents(
    ["attention_changed", "approvals_changed", "workbench_changed", "inbox_changed"],
    loadBadges,
  );
  const badgeFor = (id: string) =>
    id === "today" ? badges.needsYou : id === "inbox" ? badges.inbox : 0;

  // Core = the always-visible flat list; grouped items go under section labels.
  // Settings is pinned LAST (below the group sections), as convention expects.
  const core = navModules.filter((m) => !m.nav.group && m.id !== "settings");
  const settings = navModules.find((m) => !m.nav.group && m.id === "settings");
  const groups = new Map<string, ModuleManifest[]>();
  for (const m of navModules) {
    if (!m.nav.group) continue;
    (groups.get(m.nav.group) ?? groups.set(m.nav.group, []).get(m.nav.group)!).push(m);
  }

  return (
    <aside className="glass sticky top-3 m-3 mr-0 flex h-[calc(100vh-1.5rem)] w-52 shrink-0 flex-col rounded-(--radius-panel) p-3">
      {/* logo */}
      <Link href="/" className="mb-5 flex items-center gap-3 px-2 pt-1">
        <span className="relative flex size-9 items-center justify-center rounded-xl border border-plasma/30 bg-plasma/10">
          <span className="font-display text-lg font-bold text-plasma text-glow">a</span>
          <span className="absolute -right-0.5 -top-0.5 dot text-plasma animate-pulse-soft" />
        </span>
        <span>
          <span className="block font-display text-base font-semibold tracking-[0.18em] text-ink">
            apOS
          </span>
          <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            agentic os
          </span>
        </span>
      </Link>

      {/* nav */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        <NavItem
          href="/"
          title="Dashboard"
          accent="var(--color-plasma)"
          icon={LayoutGrid}
          active={pathname === "/"}
        />
        {core.map((m) => (
          <NavItem
            key={m.id}
            href={`/m/${m.id}`}
            title={m.title}
            accent={m.accent}
            icon={m.icon}
            active={isActiveModule(pathname, m.id)}
            badge={badgeFor(m.id)}
          />
        ))}
        {[...groups.entries()].map(([label, items]) => (
          <NavGroup key={label} label={label} items={items} pathname={pathname} />
        ))}
        {settings && (
          <NavItem
            href={`/m/${settings.id}`}
            title={settings.title}
            accent={settings.accent}
            icon={settings.icon}
            active={isActiveModule(pathname, settings.id)}
          />
        )}
      </nav>

      {/* footer */}
      <div className="mt-auto border-t border-white/5 px-2 pt-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          <span className="normal-case">apOS</span> v0.1 · local
        </p>
      </div>
    </aside>
  );
}
