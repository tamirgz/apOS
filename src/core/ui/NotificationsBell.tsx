"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Bell, CheckCheck } from "lucide-react";
import type { Notification } from "@/core/db/schema/notifications";
import { cn } from "./cn";
import { useLiveEvents } from "./useLiveEvents";
import {
  listNotifications,
  markAllNotificationsRead,
} from "./notifications-actions";

const LEVEL_COLOR = {
  info: "var(--color-ion)",
  success: "var(--color-plasma)",
  warn: "var(--color-solar)",
} as const;

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    listNotifications()
      .then((d) => {
        setRows(d.rows);
        setUnread(d.unread);
      })
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);
  useLiveEvents(["notifications"], refresh);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        className={cn(
          "relative rounded-lg border border-white/8 p-2 text-ink-dim transition hover:border-plasma/30 hover:text-plasma",
          open && "border-plasma/30 text-plasma",
        )}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-flare font-mono text-[9px] font-semibold text-void">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 480, damping: 38 }}
            className="glass glass-edge absolute right-0 top-11 z-40 w-96 overflow-hidden rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/6 px-4 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
                notifications
              </p>
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    markAllNotificationsRead().then(refresh);
                  }}
                  className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:text-ink"
                >
                  <CheckCheck className="size-3" /> mark read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {rows.length === 0 && (
                <p className="px-4 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                  all quiet
                </p>
              )}
              {rows.map((n) => {
                const inner = (
                  <div
                    className={cn(
                      "border-b border-white/4 px-4 py-3 transition hover:bg-white/3",
                      !n.readAt && "bg-white/2",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="dot shrink-0"
                        style={{ color: LEVEL_COLOR[n.level] }}
                      />
                      <p
                        className={cn(
                          "flex-1 truncate text-sm",
                          n.readAt ? "text-ink-dim" : "text-ink",
                        )}
                      >
                        {n.title}
                      </p>
                      <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                        {/* Older-than-today shows its date — a 3-day-old
                            notification used to be indistinguishable from
                            one from an hour ago. */}
                        {(() => {
                          const d = new Date(n.createdAt);
                          const time = d.toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          });
                          return d.toDateString() === new Date().toDateString()
                            ? time
                            : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
                        })()}
                      </span>
                    </div>
                    {n.body && (
                      <p className="mt-1 line-clamp-3 pl-4 text-xs leading-relaxed text-ink-dim">
                        {n.body}
                      </p>
                    )}
                    <p className="mt-1 pl-4 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                      {n.source}
                    </p>
                  </div>
                );
                return n.href ? (
                  <Link key={n.id} href={n.href} onClick={() => setOpen(false)}>
                    {inner}
                  </Link>
                ) : (
                  <div key={n.id}>{inner}</div>
                );
              })}
            </div>
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="block border-t border-white/6 px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-plasma"
            >
              full history →
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
