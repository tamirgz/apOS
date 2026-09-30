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
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition disabled:opacity-40",
        armed
          ? "border-flare/40 bg-flare/15 text-flare"
          : "border-white/8 text-ink-faint hover:bg-flare/10 hover:text-flare",
      )}
    >
      <Trash2 className="size-3.5" />
      {pending ? "…" : armed ? "confirm" : "delete"}
    </button>
  );
}
