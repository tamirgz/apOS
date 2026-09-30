"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, Info } from "lucide-react";
import { cn } from "./cn";
import { markSeen, useFeedback, type FeedbackEntry } from "./feedback";

function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Client-only: the clock must NOT render server time (hydration mismatch),
    // so it starts null and is set here on mount. The synchronous set is
    // intentional and one-off — the rule's cascading-render concern doesn't apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <span className="font-mono text-xs text-ink-faint">··:··:··</span>;

  return (
    <span className="font-mono text-xs tabular-nums text-ink-dim" suppressHydrationWarning>
      {/* Date is dropped on a phone — it eats width and the phone shows it anyway. */}
      <span className="hidden sm:inline">
        {now.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })}
        <span className="mx-2 text-ink-faint">·</span>
      </span>
      <span className="text-plasma">{now.toLocaleTimeString(undefined, { hour12: false })}</span>
    </span>
  );
}

const ICON = { done: Check, info: Info, error: CircleAlert } as const;
const TONE = { done: "text-plasma", info: "text-ion", error: "text-flare" } as const;

function Row({ e, onOpen }: { e: FeedbackEntry; onOpen: () => void }) {
  const Icon = ICON[e.level];
  const time = new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", TONE[e.level])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{e.title}</p>
        {e.body && <p className="mt-0.5 break-words text-xs leading-relaxed text-ink-dim">{e.body}</p>}
        {e.href && (
          <Link href={e.href} onClick={onOpen} className="mt-0.5 inline-block text-xs text-ion hover:underline">
            open
          </Link>
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-faint">{time}</span>
    </li>
  );
}

/**
 * The clock, doubling as the app's quiet feedback line: a success briefly takes
 * its place ("✓ Task created · open"), a red dot marks errors not yet looked at,
 * and a click lists what this tab did this session. Nothing here is persisted
 * or sent to notifications — see ./feedback.
 */
export function StatusSlot() {
  const { entries, flash, unseen } = useFeedback();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open) markSeen();
    setOpen(!open);
  };
  const FlashIcon = flash ? ICON[flash.level] : null;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label="Recent actions"
        title="Recent actions this session"
        className="relative flex h-7 items-center rounded-lg px-1.5 transition hover:bg-white/5"
      >
        <AnimatePresence mode="wait" initial={false}>
          {flash && FlashIcon ? (
            <motion.span
              key={flash.id}
              role="status"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className={cn("flex max-w-[11rem] items-center gap-1.5 text-xs sm:max-w-[18rem]", TONE[flash.level])}
            >
              <FlashIcon className="size-3.5 shrink-0" />
              <span className="truncate">{flash.title}</span>
            </motion.span>
          ) : (
            <motion.span
              key="clock"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <Clock />
            </motion.span>
          )}
        </AnimatePresence>
        {unseen > 0 && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-flare" aria-label={`${unseen} unseen errors`} />
        )}
      </button>
      {flash?.href && (
        <Link
          href={flash.href}
          className="absolute -bottom-3.5 right-1.5 font-mono text-[10px] uppercase tracking-widest text-ion hover:underline"
        >
          open
        </Link>
      )}

      {open && (
        <div className="glass absolute right-0 top-9 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl p-1.5">
          <p className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            this session
          </p>
          {entries.length === 0 ? (
            <p className="px-2.5 pb-2.5 text-xs leading-relaxed text-ink-dim">
              Nothing yet. What you save, run or send shows here, and failures stay listed after their alert
              closes.
            </p>
          ) : (
            <ul className="flex max-h-96 flex-col overflow-y-auto">
              {entries.map((e) => (
                <Row key={e.id} e={e} onOpen={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
