import Link from "next/link";
import { getProjectCockpit } from "../queries";
import { HEALTH_META } from "../health";

export async function ActiveProjectsWidget() {
  const rows = (await getProjectCockpit())
    .filter((p) => p.status === "active")
    .slice(0, 4);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-widest text-ink-faint">
        no active projects
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((p) => {
        const { total, done } = p.taskCounts;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return (
          <li key={p.id}>
            <Link
              href={`/m/projects/${p.id}`}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-ink/4"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: HEALTH_META[p.resolvedHealth.health].accent }}
                title={p.resolvedHealth.reason}
              />
              <span className="flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
                {p.name}
              </span>
              <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-ink/6">
                <span
                  className="block h-full rounded-full bg-gradient-to-r from-plasma-dim to-plasma"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest tabular-nums text-ink-faint">
                {done}/{total}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
