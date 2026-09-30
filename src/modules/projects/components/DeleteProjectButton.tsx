"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { deleteProject } from "../actions";

export function DeleteProjectButton({ id }: { id: string }) {
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onClick = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      if (!(await act(() => deleteProject(id), { failed: "Couldn't delete the project" })).ok) return;
      router.push("/m/projects");
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onBlur={() => setArmed(false)}
      disabled={pending}
      title={armed ? "Click again to confirm" : "Delete project"}
      className={cn(
        "wk-btn disabled:opacity-40",
        armed ? "!border-flare/40 !bg-flare/15 !text-flare" : "!text-ink-faint hover:!text-flare",
      )}
    >
      <Trash2 className="size-3.5" />
      {pending ? "…" : armed ? "Click again to delete" : <span className="sr-only">Delete project</span>}
    </button>
  );
}
