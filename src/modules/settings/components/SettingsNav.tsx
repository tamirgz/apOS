"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/core/ui/cn";

/** The Settings hub tabs. Each links to a sub-page; "" (root) is Models. */
const TABS = [
  { href: "/m/settings/models", label: "Models & Routing", match: ["", "models"] },
  { href: "/m/settings/connections", label: "Connections", match: ["connections"] },
  { href: "/m/settings/appearance", label: "Appearance", match: ["appearance"] },
  { href: "/m/settings/memory", label: "Memory", match: ["memory"] },
  { href: "/m/settings/usage", label: "Usage", match: ["usage"] },
  { href: "/m/settings/activity", label: "Activity", match: ["activity"] },
];

export function SettingsNav() {
  const path = usePathname();
  const seg = (path.replace(/^\/m\/settings\/?/, "").split("/")[0] ?? "").trim();
  return (
    <nav className="mb-6 flex flex-wrap gap-1.5 border-b border-white/6 pb-3">
      {TABS.map((t) => {
        const active = t.match.includes(seg);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "rounded-lg px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
              active
                ? "bg-ion/15 text-ion"
                : "text-ink-faint hover:bg-white/5 hover:text-ink-dim",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
