"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getModule } from "@/modules/registry";
import { NotificationsBell } from "./NotificationsBell";

function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <span className="font-mono text-xs text-ink-faint">··:··:··</span>;

  return (
    <span className="font-mono text-xs tabular-nums text-ink-dim">
      {now.toLocaleDateString(undefined, {
        weekday: "short",
        day: "2-digit",
        month: "short",
      })}
      <span className="mx-2 text-ink-faint">·</span>
      <span className="text-plasma">
        {now.toLocaleTimeString(undefined, { hour12: false })}
      </span>
    </span>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const moduleId = pathname.startsWith("/m/") ? pathname.split("/")[2] : null;
  const mod = moduleId ? getModule(moduleId) : null;
  const CORE_TITLES: Record<string, string> = {
    "/deck": "Deck",
    "/notifications": "Notifications",
  };
  const title = mod?.title ?? CORE_TITLES[pathname] ?? "apOS";

  return (
    <header className="mb-4 flex items-center justify-between">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-xl font-semibold tracking-wide text-ink">
          {title}
        </h1>
        <p className="font-mono text-[9px] uppercase tracking-[0.3em] text-ink-faint">
          <span className="normal-case">apOS</span> /{" "}
          <span style={mod ? { color: mod.accent } : { color: "var(--color-plasma)" }}>
            {title.toLowerCase()}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <NotificationsBell />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("aios:commandbar"))}
          className="flex items-center gap-2 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-plasma/30 hover:text-plasma"
          title="Open command bar"
        >
          <span className="text-plasma">⌘K</span> command
        </button>
        <Clock />
      </div>
    </header>
  );
}
