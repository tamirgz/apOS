import type { AgentAuditRow } from "@/core/db/schema/agents";
import { timeAgo } from "@/core/ui/time";

/** Event → chip color + human label. Unknown events render as-is. */
const EVENT_META: Record<string, { label: string; color: string }> = {
  "gate.run": { label: "gate → run", color: "var(--color-plasma)" },
  "gate.skip": { label: "gate → skip", color: "var(--color-ink-faint)" },
  "run.requested": { label: "run now", color: "var(--color-ion)" },
  "run.started": { label: "started", color: "var(--color-ion)" },
  "run.fallback": { label: "fallback", color: "var(--color-solar)" },
  "run.finished": { label: "finished", color: "var(--color-plasma)" },
  "run.skipped_live": { label: "overlap skip", color: "var(--color-ink-faint)" },
  "approval.decided": { label: "approval", color: "var(--color-gold)" },
  "config.created": { label: "created", color: "var(--color-ion)" },
  "config.updated": { label: "config", color: "var(--color-ion)" },
  "config.deleted": { label: "deleted", color: "var(--color-flare)" },
};

/** One line of human-readable summary per event, from its detail payload. */
function summarize(row: AgentAuditRow): string {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  switch (row.event) {
    case "gate.run":
    case "gate.skip":
    case "run.skipped_live":
      return String(d.reason ?? "");
    case "run.started":
      return `${d.provider}/${d.model} · ${d.trigger}${d.override ? " · node override" : ""}`;
    case "run.fallback": {
      const from = d.from as { provider?: string; model?: string } | undefined;
      const to = d.to as { provider?: string; model?: string } | undefined;
      return `${from?.provider}/${from?.model} → ${to?.provider}/${to?.model}`;
    }
    case "run.finished": {
      const dur = d.durationMs ? ` · ${Math.round(Number(d.durationMs) / 1000)}s` : "";
      const tok =
        d.tokensIn != null ? ` · ${Number(d.tokensIn) + Number(d.tokensOut ?? 0)} tok` : "";
      return `${d.status}${dur}${tok}${d.error ? ` · ${String(d.error).slice(0, 120)}` : ""}`;
    }
    case "approval.decided":
      return `${d.approved ? "approved" : "rejected"} ${d.toolName}`;
    case "config.updated":
      return `changed: ${Object.keys((d.changed as object) ?? {}).join(", ")}`;
    case "config.created":
      return [d.schedule && `schedule ${d.schedule}`, d.model && `${d.provider}/${d.model}`]
        .filter(Boolean)
        .join(" · ");
    default:
      return "";
  }
}

/**
 * The agent's decision trail — every gate verdict, run (with the model that
 * actually ran), fallback, approval and config change, newest first. This is
 * the auditability surface: nothing the system decides about an agent happens
 * off the record.
 */
export function AuditTrail({ rows }: { rows: AgentAuditRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="glass mt-5 rounded-2xl p-4">
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        decision trail · {rows.length} recent
      </p>
      <div className="flex flex-col">
        {rows.map((r) => {
          const meta = EVENT_META[r.event] ?? { label: r.event, color: "var(--color-ink-dim)" };
          const summary = summarize(r);
          return (
            <div
              key={r.id}
              className="flex items-baseline gap-3 border-b border-white/4 py-1.5 last:border-0"
            >
              <span
                className="w-24 shrink-0 font-mono text-[9px] uppercase tracking-widest"
                style={{ color: meta.color }}
              >
                {meta.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-dim" title={summary}>
                {summary}
              </span>
              <span className="shrink-0 font-mono text-[9px] tabular-nums text-ink-faint">
                {timeAgo(r.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
