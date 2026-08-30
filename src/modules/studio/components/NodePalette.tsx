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
    <div className="flex w-52 flex-col gap-2">
      {PALETTE_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-1 pb-0.5 font-mono text-[9px] uppercase tracking-[0.28em] text-ink-faint/70">
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = item.Icon;
            return (
              <button
                key={item.key}
                type="button"
                title={item.blurb}
                onClick={() => onAdd(item.kind, item.config)}
                className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left transition hover:border-plasma/20 hover:bg-plasma/5"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                  style={{ background: `${item.color}22`, color: item.color }}
                >
                  <Icon className="h-3 w-3" />
                </span>
                <span className="truncate text-[13px] leading-tight text-ink">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
