"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Pencil, X } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { updateProject } from "../actions";

/**
 * Inline-editable project name. Because every cross-module link is by project
 * id (never the name), saving here propagates the new name everywhere it's
 * shown; updateProject also nulls the embedding so the sweep re-ingests it.
 */
export function ProjectTitle({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();

  const commit = () => {
    const next = value.trim();
    setEditing(false);
    if (!next || next === name) {
      setValue(name);
      return;
    }
    start(async () => {
      if (!(await act(() => updateProject(id, { name: next }), { failed: "Couldn't rename the project" })).ok) {
        setValue(name);
        return;
      }
      router.refresh(); // reflect the new name across this page + refs
    });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setValue(name);
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="w-full max-w-lg rounded-lg bg-white/5 px-2 py-1 font-display text-3xl font-semibold text-ink outline-none focus:bg-white/8"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          title="Save"
          className="rounded-md p-1.5 text-plasma transition hover:bg-plasma/10"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setValue(name);
            setEditing(false);
          }}
          title="Cancel"
          className="rounded-md p-1.5 text-ink-faint transition hover:bg-white/6 hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
      title="Rename project"
      className={cn(
        "group/title flex items-center gap-2 rounded-lg text-left transition hover:bg-white/4",
        pending && "opacity-50",
      )}
    >
      <h1 className="font-display text-3xl font-semibold text-ink">{name}</h1>
      <Pencil className="size-3.5 shrink-0 text-ink-faint opacity-0 transition group-hover/title:opacity-100" />
    </button>
  );
}
