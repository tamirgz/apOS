"use client";

import { act } from "@/core/ui/feedback";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import { requestVaultSync } from "../actions";

export function VaultControls({
  root,
  total,
  embedded,
  lastSync,
}: {
  root: string;
  total: number;
  embedded: number;
  lastSync: string | null;
}) {
  const [pending, startTransition] = useTransition();
  useLiveEvents(["obsidian_changed"]);

  return (
    <div className="glass flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl p-4">
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          vault
        </p>
        <p className="max-w-xs truncate font-mono text-xs text-ink" title={root}>
          {root}
        </p>
      </div>
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          indexed
        </p>
        <p className="font-display text-xl font-semibold text-ink">{total}</p>
      </div>
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          embedded
        </p>
        <p className="font-display text-xl font-semibold text-violet">
          {embedded}
        </p>
      </div>
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          last sync
        </p>
        <p className="font-mono text-xs text-ink-dim">
          {lastSync ? new Date(lastSync).toLocaleTimeString() : "never"}
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await act(requestVaultSync, { failed: "Couldn't start the vault sync", done: "Vault sync started" });
          })
        }
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-violet/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-violet transition hover:bg-violet/10 disabled:opacity-40"
      >
        <RefreshCw className={cn("size-3", pending && "animate-spin")} />
        sync now
      </button>
    </div>
  );
}
