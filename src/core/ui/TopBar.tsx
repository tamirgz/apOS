"use client";

import { usePathname } from "next/navigation";
import { Command } from "lucide-react";
import { getModule } from "@/modules/registry";
import { NotificationsBell } from "./NotificationsBell";
import { StatusSlot } from "./StatusSlot";

export function TopBar() {
  const pathname = usePathname();
  const moduleId = pathname.startsWith("/m/") ? pathname.split("/")[2] : null;
  const mod = moduleId ? getModule(moduleId) : null;
  const CORE_TITLES: Record<string, string> = {
    "/notifications": "Notifications",
  };
  const title = mod?.title ?? CORE_TITLES[pathname] ?? "apOS";

  // On a phone the fixed menu button sits over this row — clear it here, not
  // with a gutter down the whole page.
  return (
    <header className="mb-4 flex items-center justify-between gap-2 max-md:pl-11">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="truncate font-display text-xl font-semibold tracking-wide text-ink">
          {title}
        </h1>
        {/* Breadcrumb is redundant with the title — hide it on a phone. */}
        <p className="hidden font-mono text-[9px] uppercase tracking-[0.3em] text-ink-faint sm:block">
          <span className="normal-case">apOS</span> /{" "}
          <span style={mod ? { color: mod.accent } : { color: "var(--color-plasma)" }}>
            {title.toLowerCase()}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <NotificationsBell />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("aios:commandbar"))}
          className="flex items-center gap-2 rounded-lg border border-white/8 px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-plasma/30 hover:text-plasma sm:px-3"
          title="Open command bar / search"
          aria-label="Open command bar"
        >
          {/* Phone: just the ⌘ glyph (no keyboard shortcut to spell out). */}
          <Command className="size-3.5 text-plasma sm:hidden" />
          <span className="hidden sm:inline">
            <span className="text-plasma">⌘K</span> command
          </span>
        </button>
        <StatusSlot />
      </div>
    </header>
  );
}
