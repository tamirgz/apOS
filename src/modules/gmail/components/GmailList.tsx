"use client";

import { timeAgo } from "@/core/ui/time";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, ListPlus, Mail, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { mailToWorkItem, resyncGmail } from "../actions";
import type { GmailMessage } from "../schema";

const ago = (d: Date | null) => timeAgo(d, { compact: true });

/** resyncGmail's "not connected" / "needs re-consent" outcomes, as failures. */
async function resync() {
  const r = await resyncGmail();
  if (!r) return { ok: false as const, synced: 0, error: "Google isn't connected. Connect it in Settings → Connections." };
  if ("needsReconsent" in r)
    return { ok: false as const, synced: 0, error: "Google needs you to re-approve Gmail access. Reconnect in Settings → Connections." };
  return r;
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
          onClick={() => start(async () => void (await act(resync, { failed: "Couldn't sync Gmail", done: (r) => `Gmail synced · ${r.synced} messages` })))}
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
            <motion.div
              key={m.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="glass group flex items-center gap-3 rounded-xl p-3 transition hover:bg-white/4"
            >
              <a
                href={m.link ?? undefined}
                target={m.link ? "_blank" : undefined}
                rel={m.link ? "noopener noreferrer" : undefined}
                className="flex min-w-0 flex-1 items-center gap-3"
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
              </a>
              <MailActions message={m} />
            </motion.div>
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

/** Per-message actions: make it a work item, ask about it, open in Gmail. */
function MailActions({ message: m }: { message: GmailMessage }) {
  const [pending, start] = useTransition();
  const [itemId, setItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const askQ = `What does the mail "${m.subject ?? ""}" from ${m.fromName ?? m.fromEmail ?? "this sender"} need from me?`;
  const btn =
    "rounded-md p-1.5 text-ink-faint transition hover:bg-white/5 focus-visible:opacity-100 disabled:opacity-40";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {itemId ? (
        <Link
          href={`/m/tasks/${itemId}`}
          className="rounded-md border border-plasma/30 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
        >
          open item
        </Link>
      ) : (
        <button
          type="button"
          title={error ?? "Make a work item (Reply: …) with the Gmail link"}
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                setItemId((await mailToWorkItem(m.id)).id);
              } catch (e) {
                setError(e instanceof Error ? e.message : "failed");
              }
            })
          }
          className={cn(btn, "opacity-0 group-hover:opacity-100 hover:text-plasma", error && "text-flare opacity-100")}
        >
          <ListPlus className="size-3.5" />
        </button>
      )}
      <Link
        href={`/m/ask?q=${encodeURIComponent(askQ)}`}
        title="Ask about this mail"
        className={cn(btn, "opacity-0 group-hover:opacity-100 hover:text-ion")}
      >
        <Sparkles className="size-3.5" />
      </Link>
      {m.link && (
        <a
          href={m.link}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in Gmail"
          className={cn(btn, "opacity-0 group-hover:opacity-100 hover:text-ink")}
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}
