"use client";

import type { FlowNodeKind } from "@/modules/flows/schema";
import { PALETTE_GROUPS } from "../nodes";

/** Left rail — grouped by role; click a block to drop it on the canvas. */
export function NodePalette({
  onAdd,
}: {
  onAdd: (kind: FlowNodeKind, config?: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex w-56 flex-col gap-3">
      <p className="px-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
        blocks
      </p>
      {PALETTE_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="px-1 font-mono text-[9px] uppercase tracking-[0.3em] text-ink-faint/70">
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = item.Icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onAdd(item.kind, item.config)}
                className="flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left transition hover:border-plasma/20 hover:bg-plasma/5"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `${item.color}22`, color: item.color }}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">{item.label}</span>
                  <span className="block truncate text-[11px] text-ink-faint">{item.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
