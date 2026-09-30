import Link from "next/link";
import { listRecentRunsAcrossAgents } from "../queries";
import { RUN_STATUS_META } from "../components/runMeta";

export async function AgentActivityWidget() {
  // Latest run per agent — a chatty agent listed twice crowded out the rest.
  const seen = new Set<string>();
  const rows = (await listRecentRunsAcrossAgents(30))
    .filter(({ run }) => !seen.has(run.agentId) && !!seen.add(run.agentId))
    .slice(0, 5);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        no agent activity yet
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ run, agentName }) => {
        const status = RUN_STATUS_META[run.status];
        return (
          <li key={run.id}>
            <Link
              href={`/m/agents/${run.agentId}`}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/4"
            >
              <span
                className={`dot ${status.pulse ? "animate-pulse-soft" : ""}`}
                style={{ color: status.color }}
              />
              <span className="text-sm text-ink-dim transition group-hover:text-ink">
                {agentName}
              </span>
              <span className="flex-1 truncate font-mono text-[10px] text-ink-faint">
                {run.result?.slice(0, 60) ?? run.error?.slice(0, 60) ?? ""}
              </span>
              <span
                className="font-mono text-[9px] uppercase tracking-widest"
                style={{ color: status.color }}
              >
                {status.label}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
