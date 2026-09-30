"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { act } from "@/core/ui/feedback";
import { shortDate } from "@/core/ui/time";
import { createTask } from "../actions";
import { parseQuick } from "../parse";
import type { WorkData } from "../queries";
import { PRIORITY_META, STATUS_META } from "../states";
import { LabelPill } from "./work-ui";

/**
 * "New item" — a centred command-style dialog (C anywhere on Work). Type the
 * title with tokens; what the parser understood shows as chips before Enter.
 */
export function QuickCreate({
  open,
  onClose,
  onCreated,
  data,
  projectId,
  featureId,
  cycleId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  data: WorkData;
  projectId?: string;
  featureId: string | null;
  cycleId?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = parseQuick(text);
  const keyed = parsed.projectKey ? data.projects.find((p) => p.key === parsed.projectKey) : undefined;
  const scopeProject = projectId ? data.projects.find((p) => p.id === projectId) : undefined;
  const target = keyed ?? scopeProject;
  const cycleName = cycleId ? data.cycles.find((c) => c.id === cycleId)?.name : undefined;
  const moduleName = featureId ? data.features.find((f) => f.id === featureId)?.name : undefined;

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const submit = () => {
    if (!parsed.title || pending) return;
    const projectRef = target ? `projects:${target.id}` : null;
    const input = {
      title: parsed.title,
      priority: parsed.priority,
      labels: parsed.labels,
      dueAt: parsed.dueAt ?? null,
      estimate: parsed.estimate ?? null,
      status: parsed.status,
      projectRef,
      featureRef: featureId && (!keyed || keyed.id === projectId) ? `features:${featureId}` : null,
      cycleId: cycleId ?? null,
    };
    start(async () => {
      const r = await act(() => createTask(input), {
        failed: "Couldn't create the item",
        done: (t) => `${t.identifier ?? "Item"} created`,
        href: (t) => `/m/tasks/${t.id}`,
      });
      if (!r.ok) return;
      setText("");
      onClose();
      router.refresh();
      onCreated(r.value.id);
    });
  };

  const chip = "wk-chip !text-[12px]";
  const k = "font-mono text-ink-faint";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="qc"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          className="fixed inset-0 z-50 grid place-items-start justify-center bg-void/60 px-4 pt-[14vh] backdrop-blur-[3px]"
          role="dialog"
          aria-modal="true"
          aria-label="New work item"
        >
          <motion.form
            initial={{ y: -8, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="glass w-[min(620px,calc(100vw-32px))] rounded-2xl p-4"
          >
            <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              New work item · {target ? target.name : "no project"}
              {moduleName && ` · ${moduleName}`}
              {cycleName && ` · ${cycleName}`}
            </div>
            <input
              ref={inputRef}
              dir="auto"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())}
              placeholder="Describe it…"
              aria-label="New work item"
              autoComplete="off"
              disabled={pending}
              className="w-full border-b border-ion/20 bg-transparent px-0.5 py-2 text-[17px] font-medium text-ink outline-none transition placeholder:text-ink-faint focus:border-plasma"
            />
            <div className="mb-1 mt-3 flex min-h-6 flex-wrap gap-1.5">
              <span className={`${chip} !text-ink`} dir="auto">
                “{parsed.title || "…"}”
              </span>
              {parsed.priority && (
                <span className={chip}>
                  <span className={k}>priority</span> {PRIORITY_META[parsed.priority].label}
                </span>
              )}
              {parsed.status && (
                <span className={chip}>
                  <span className={k}>state</span> {STATUS_META[parsed.status].label}
                </span>
              )}
              {parsed.dueAt && (
                <span className={chip}>
                  <span className={k}>due</span> {shortDate(parsed.dueAt)}
                </span>
              )}
              {parsed.labels.map((l) => (
                <LabelPill key={l} l={l} />
              ))}
              {parsed.estimate != null && (
                <span className={chip}>
                  <span className={k}>estimate</span> {parsed.estimate} pts
                </span>
              )}
              {parsed.projectKey && (
                <span className={chip} style={keyed ? undefined : { color: "var(--color-flare)" }}>
                  <span className={k}>project</span> {keyed ? keyed.name : `no project ${parsed.projectKey}`}
                </span>
              )}
            </div>
            <p className="mt-2.5 text-xs leading-relaxed text-ink-faint">
              Priority <span className="font-mono">p0–p3</span> or <span className="font-mono">!high</span> · due{" "}
              <span className="font-mono">due fri</span> or <span className="font-mono">@10-12</span> · labels{" "}
              <span className="font-mono">#perf</span> · estimate <span className="font-mono">3pts</span> · project{" "}
              <span className="font-mono">+KEY</span> · state <span className="font-mono">&gt;doing</span>.{" "}
              <kbd className="wk-kbd">Enter</kbd> creates · <kbd className="wk-kbd">Esc</kbd> closes.
            </p>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
