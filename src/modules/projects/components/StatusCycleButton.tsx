"use client";

import { useTransition } from "react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { updateProject } from "../actions";
import { PROJECT_STATUSES, type ProjectStatus } from "../schema";
import { STATUS_CHIP } from "./statusStyle";

export function StatusCycleButton({
  id,
  status,
}: {
  id: string;
  status: ProjectStatus;
}) {
  const [pending, startTransition] = useTransition();

  const cycle = () => {
    const idx = PROJECT_STATUSES.indexOf(status);
    const next = PROJECT_STATUSES[(idx + 1) % PROJECT_STATUSES.length];
    startTransition(async () => {
      await act(() => updateProject(id, { status: next }), { failed: "Couldn't change the project status" });
    });
  };

  return (
    <button
      type="button"
      onClick={cycle}
      disabled={pending}
      title={`Status: ${status} (click to cycle)`}
      className={cn(
        "rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition hover:brightness-125 disabled:opacity-40",
        STATUS_CHIP[status],
      )}
    >
      {pending ? "…" : status}
    </button>
  );
}
