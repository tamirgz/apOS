"use client";

import type { FlowNodeKind } from "@/modules/flows/schema";
import { KIND_META, PALETTE_KINDS } from "../nodes";

/** Left rail — click a kind to drop it on the canvas. */
export function NodePalette({ onAdd }: { onAdd: (kind: FlowNodeKind) => void }) {
  return (
    <div className="flex w-52 flex-col gap-1">
      <p className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
        blocks
      </p>
      {PALETTE_KINDS.map((kind) => {
        const m = KIND_META[kind];
        const Icon = m.Icon;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onAdd(kind)}
            className="flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-plasma/20 hover:bg-plasma/5"
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              style={{ background: `${m.color}22`, color: m.color }}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{m.label}</span>
              <span className="block truncate text-[11px] text-ink-faint">{m.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
