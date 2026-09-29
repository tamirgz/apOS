"use client";

import { useRouter } from "next/navigation";
import type { WorkProject } from "../queries";
import { WorkItemDetail } from "./WorkItemDetail";

/** Full-page host for WorkItemDetail: navigation goes through the router. */
export function WorkItemPage({ id, projects }: { id: string; projects: WorkProject[] }) {
  const router = useRouter();
  return (
    <WorkItemDetail
      id={id}
      projects={projects}
      full
      onChanged={() => router.refresh()}
      onOpenItem={(next) => router.push(`/m/tasks/${next}`)}
      onDeleted={() => router.push("/m/tasks")}
    />
  );
}
