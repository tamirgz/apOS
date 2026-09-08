"use client";

import { useState, type ReactNode } from "react";
import { LineChart, MessageSquare, type LucideIcon } from "lucide-react";
import { cn } from "@/core/ui/cn";

function TabBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
        active
          ? "bg-plasma/15 text-plasma"
          : "text-ink-faint hover:bg-white/5 hover:text-ink-dim",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/**
 * Splits the Investments page into Portfolio (the server-rendered overview) and
 * Chat tabs. Both children stay MOUNTED — hidden via CSS, not unmounted — so the
 * chat keeps its scroll/input/history when you switch away and the overview
 * doesn't refetch iSentry. Server components are passed in as props (children),
 * which is allowed from a client boundary.
 */
export function InvestmentsTabs({
  overview,
  chat,
  actions,
}: {
  overview: ReactNode;
  chat: ReactNode;
  /** Portfolio-tab-only header controls (e.g. the Report button + status). */
  actions?: ReactNode;
}) {
  const [tab, setTab] = useState<"portfolio" | "chat">("portfolio");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-white/6 p-1">
          <TabBtn active={tab === "portfolio"} onClick={() => setTab("portfolio")} icon={LineChart} label="portfolio" />
          <TabBtn active={tab === "chat"} onClick={() => setTab("chat")} icon={MessageSquare} label="chat" />
        </div>
        {tab === "portfolio" && actions}
      </div>
      <div className={cn(tab !== "portfolio" && "hidden")}>{overview}</div>
      <div className={cn(tab !== "chat" && "hidden")}>{chat}</div>
    </div>
  );
}
