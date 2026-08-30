"use client";

import Link from "next/link";
import { useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Mail, RefreshCw } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { resyncGmail } from "../actions";
import type { GmailMessage } from "../schema";

function ago(d: Date | null): string {
  if (!d) return "";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function GmailList({
  messages,
  connected,
  authorized,
}: {
  messages: GmailMessage[];
  connected: boolean;
  authorized: boolean;
}) {
  const [pending, start] = useTransition();

  if (!connected || !authorized) {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-2xl px-8 py-16 text-center">
        <Mail className="size-7 text-flare" />
        <h2 className="font-display text-xl font-semibold text-ink">
          {connected ? "Grant Gmail access" : "Connect Google"}
        </h2>
        <p className="max-w-md text-sm text-ink-dim">
          {connected
            ? "Google is connected for Calendar, but the token doesn't include Gmail yet. Re-run Connect Google to grant read-only Gmail — it'll ask once, then recent mail appears here and feeds your daily plan + follow-ups."
            : "Connect your Google account to mirror recent mail (read-only)."}
        </p>
        <Link
          href="/m/settings/connections"
          className="mt-1 rounded-lg border border-flare/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-flare transition hover:bg-flare/10"
        >
          {connected ? "reconnect in Settings" : "connect in Settings"}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
          <Mail className="size-3.5 text-flare" />
          {messages.length} recent · read-only
        </p>
        <button
          type="button"
          onClick={() => start(async () => void (await resyncGmail()))}
          disabled={pending}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3", pending && "animate-spin")} />
          {pending ? "syncing…" : "resync"}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <AnimatePresence mode="popLayout">
          {messages.map((m) => (
            <motion.a
              key={m.id}
              layout
              href={m.link ?? undefined}
              target={m.link ? "_blank" : undefined}
              rel={m.link ? "noopener noreferrer" : undefined}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="glass group flex items-center gap-3 rounded-xl p-3 transition hover:bg-white/4"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  m.unread ? "bg-flare" : "bg-transparent",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      m.unread ? "font-medium text-ink" : "text-ink-dim",
                    )}
                  >
                    {m.fromName ?? m.fromEmail ?? "unknown"}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                    {ago(m.receivedAt)}
                  </span>
                </div>
                <p className="truncate text-sm text-ink-dim">{m.subject ?? "(no subject)"}</p>
                {m.snippet && (
                  <p className="truncate text-xs text-ink-faint">{m.snippet}</p>
                )}
              </div>
              <ExternalLink className="size-3.5 shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
            </motion.a>
          ))}
        </AnimatePresence>
        {messages.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/6 py-12 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            no recent mail — hit resync
          </div>
        )}
      </div>
    </div>
  );
}
