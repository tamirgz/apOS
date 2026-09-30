"use client";

import { useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ShieldAlert, X } from "lucide-react";
import type { Approval } from "@/core/db/schema/approvals";
import { act } from "@/core/ui/feedback";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { decideApproval } from "../actions";

export function ApprovalsPanel({ pending }: { pending: Approval[] }) {
  const [, startTransition] = useTransition();
  useLiveEvents(["approvals_changed"]);

  if (pending.length === 0) return null;

  return (
    <div className="mb-2">
      <p className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-solar">
        <ShieldAlert className="size-3.5" />
        awaiting your approval · {pending.length}
      </p>
      <div className="flex flex-col gap-2.5">
        <AnimatePresence mode="popLayout">
          {pending.map((a) => (
            <motion.div
              key={a.id}
              id={`approval-${a.id}`}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="glass glass-edge scroll-mt-20 rounded-xl p-4 target:ring-1 target:ring-solar/60"
              style={{ borderColor: "color-mix(in oklab, var(--color-solar) 30%, transparent)" }}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs text-solar">{a.toolName}</span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                  by {a.agentName}
                </span>
                <span className="ml-auto font-mono text-[9px] text-ink-faint">
                  {new Date(a.createdAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <pre className="mb-3 max-h-32 overflow-auto rounded-lg border border-white/6 bg-abyss/60 p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
                {JSON.stringify(a.input, null, 2)}
              </pre>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await act(() => decideApproval(a.id, false), { failed: "Couldn't reject the action" });
                    })
                  }
                  className="flex items-center gap-1.5 rounded-lg border border-flare/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-flare transition hover:bg-flare/10"
                >
                  <X className="size-3" /> reject
                </button>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await act(() => decideApproval(a.id, true), { failed: "Couldn't approve the action" });
                    })
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-plasma/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25"
                >
                  <Check className="size-3" /> approve & run
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
