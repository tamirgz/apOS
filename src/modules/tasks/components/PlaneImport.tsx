"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Download, Loader2, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { planeImportState, startPlaneImport } from "../actions";
import type { PlaneImportStatus } from "../plane/import";

type State = Awaited<ReturnType<typeof planeImportState>>;

/**
 * Import from Plane: preview (read-only) → pick projects → import. The work
 * runs on the worker (Plane allows 60 requests/min); this panel polls the
 * progress it writes.
 */
export function PlaneImport({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const status = state?.status ?? null;
  const running = status?.state === "running";

  // Poll while a run is in flight; one read otherwise.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      planeImportState().then((s) => {
        if (!alive) return;
        setState(s);
        if (s.status?.state === "running") timer = setTimeout(tick, 2000);
        else if (s.status?.mode === "import" && s.status.state === "done") router.refresh();
      });
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [router, running]);

  const plan = status?.mode === "preview" && status.state === "done" ? (status.plan ?? []) : null;
  const importable = plan?.filter((p) => !p.archived) ?? [];
  // Default selection: every live project — seeded once per preview.
  const [seedFor, setSeedFor] = useState<string | null>(null);
  if (plan && seedFor !== status!.startedAt) {
    setSeedFor(status!.startedAt);
    setChosen(new Set(importable.map((p) => p.planeId)));
  }

  const go = (mode: "preview" | "import") =>
    start(async () => {
      setError(null);
      try {
        await startPlaneImport(mode, mode === "import" ? [...(chosen ?? [])] : undefined);
        setState(await planeImportState());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  // Portaled: an ancestor's backdrop-filter would otherwise become the fixed
  // overlay's containing block and clip the dialog to the toolbar's box.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-void/70 p-4 pt-[10vh] backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import from Plane"
        onClick={(e) => e.stopPropagation()}
        className="glass relative flex w-full max-w-2xl flex-col gap-4 rounded-2xl p-6"
      >
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-faint hover:bg-white/6 hover:text-ink">
          <X className="size-4" />
        </button>
        <header className="flex items-center gap-2 pr-8">
          <Download className="size-4 text-ion" />
          <h2 className="font-display text-lg text-ink">Import from Plane</h2>
        </header>

        {!state ? (
          <Loader2 className="size-4 animate-spin text-ink-faint" />
        ) : !state.configured ? (
          <div className="flex flex-col gap-2 text-sm text-ink-dim">
            <p>Connect Plane first:</p>
            <ol className="list-decimal space-y-1 pl-5 text-ink-faint">
              <li>In Plane: Profile settings → Personal access tokens → Add token. Copy it.</li>
              <li>
                Open <Link href="/m/settings/connections" className="text-ion underline-offset-2 hover:underline">Settings → Connections</Link> → Work tracking → Plane.
              </li>
              <li>Fill in your Plane URL (blank for Plane Cloud), workspace slug, and the token.</li>
              <li>Come back here and run a preview.</li>
            </ol>
          </div>
        ) : (
          <>
            <p className="text-sm text-ink-faint">
              Modules become features, cycles become cycles, work items keep their state, priority, labels, dates, description and
              sub-items. Re-running updates what changed in Plane (it overwrites those fields here). Comments, assignees and
              estimates aren&apos;t imported.
            </p>

            {plan && (
              <div className="overflow-x-auto rounded-xl border border-white/6">
                <table className="w-full text-sm">
                  <thead className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    <tr className="border-b border-white/6">
                      <th className="w-8 p-2" />
                      <th className="p-2 text-left font-normal">Plane project</th>
                      <th className="p-2 text-left font-normal">Into</th>
                      <th className="p-2 text-right font-normal">Items</th>
                      <th className="p-2 text-right font-normal">New</th>
                      <th className="p-2 text-right font-normal">Modules</th>
                      <th className="p-2 text-right font-normal">Cycles</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {plan.map((p) => (
                      <tr key={p.planeId} className={cn("border-b border-white/4 last:border-0", p.archived && "opacity-40")}>
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            disabled={p.archived || running}
                            checked={!!chosen?.has(p.planeId)}
                            onChange={(e) =>
                              setChosen((prev) => {
                                const n = new Set(prev);
                                if (e.target.checked) n.add(p.planeId);
                                else n.delete(p.planeId);
                                return n;
                              })
                            }
                            aria-label={`Import ${p.name}`}
                          />
                        </td>
                        <td className="p-2">
                          <span className="mr-2 font-mono text-[10px] text-ink-faint">{p.identifier}</span>
                          <span dir="auto" className="text-ink-dim">{p.name}</span>
                          {p.archived && <span className="ml-2 font-mono text-[10px] text-ink-faint">archived — skipped</span>}
                        </td>
                        <td className="p-2 text-xs">
                          {p.localId ? <span className="text-ink-dim">{p.localName}</span> : <span className="text-plasma">new project</span>}
                        </td>
                        <td className="p-2 text-right font-mono text-xs text-ink-dim">{p.items}</td>
                        <td className="p-2 text-right font-mono text-xs text-plasma">{p.newItems}</td>
                        <td className="p-2 text-right font-mono text-xs text-ink-faint">{p.modules}</td>
                        <td className="p-2 text-right font-mono text-xs text-ink-faint">{p.cycles}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {status?.mode === "import" && status.state === "done" && status.result && (
              <p className="rounded-xl bg-plasma/8 px-3 py-2 text-sm text-plasma">
                Imported {status.result.projects} project{status.result.projects === 1 ? "" : "s"}: {status.result.created} new items,{" "}
                {status.result.updated} already here (synced), {status.result.features} features, {status.result.cycles} cycles.
              </p>
            )}
            {status?.state === "failed" && <p className="rounded-xl bg-flare/8 px-3 py-2 text-sm text-flare">{status.error}</p>}
            {error && <p className="text-sm text-flare">{error}</p>}

            {status && (running || status.log.length > 0) && <ProgressLog status={status} />}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pending || running}
                onClick={() => go("preview")}
                className="rounded-lg border border-white/10 px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 disabled:opacity-40"
              >
                {plan ? "preview again" : "preview"}
              </button>
              {plan && (
                <button
                  type="button"
                  disabled={pending || running || !chosen?.size}
                  onClick={() => go("import")}
                  className="rounded-lg bg-ion/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
                >
                  import {chosen?.size ?? 0} project{chosen?.size === 1 ? "" : "s"}
                </button>
              )}
              {running && (
                <span className="ml-auto flex items-center gap-2 font-mono text-[10px] text-ink-faint">
                  <Loader2 className="size-3.5 animate-spin" /> {status!.step}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ProgressLog({ status }: { status: PlaneImportStatus }) {
  return (
    <details open={status.state === "running"} className="rounded-xl border border-white/6">
      <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        {status.mode} log · {status.state}
      </summary>
      <pre className="max-h-48 overflow-y-auto px-3 pb-3 font-mono text-[10px] leading-relaxed text-ink-faint">{status.log.join("\n")}</pre>
    </details>
  );
}
