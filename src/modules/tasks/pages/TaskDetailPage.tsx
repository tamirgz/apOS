import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { db } from "@/core/db/client";
import { findByIdentifier } from "../core";
import { loadWorkData } from "../queries";
import { WorkItemPage } from "../components/WorkItemPage";

/**
 * /m/tasks/<id | KEY-N> — the permalink for a work item (planner cards, triage
 * results, search hits, widgets, commit links). Accepts the uuid or the human
 * identifier, so "ETHOS-12" is a URL you can type.
 */
export async function TaskDetailPage({ params }: ModuleRouteProps) {
  const [raw] = params;
  const ref = decodeURIComponent(raw ?? "");
  const id = /^[0-9a-f-]{36}$/i.test(ref) ? ref : (await findByIdentifier(db, ref))?.id;
  const { projects } = await loadWorkData();

  return (
    <div className="max-w-2xl">
      <Link
        href="/m/tasks"
        className="mb-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
      >
        <ArrowLeft className="size-3.5" />
        work
      </Link>
      {id ? (
        <div className="glass rounded-2xl p-6">
          <WorkItemPage id={id} projects={projects} />
        </div>
      ) : (
        <p className="glass rounded-2xl px-8 py-16 text-center font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          no work item {ref}
        </p>
      )}
    </div>
  );
}
