"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Check, FolderKanban } from "lucide-react";
import type { ProjectSuggestion } from "@/core/embeddings";
import { act } from "@/core/ui/feedback";

/**
 * "Looks like it belongs to <project>" with a confirm-to-link button.
 * `onLink` is a server action bound to the source entity.
 */
export function ProjectSuggestionCard({
  suggestion,
  onLink,
}: {
  suggestion: ProjectSuggestion;
  onLink: (projectId: string) => Promise<unknown>;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <section className="glass glass-edge rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <FolderKanban className="size-4 shrink-0 text-solar" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-solar">
            {suggestion.confidence === "strong"
              ? "looks like it belongs to"
              : "maybe part of"}
          </p>
          <p className="truncate text-sm font-medium text-ink">
            {suggestion.name}
          </p>
        </div>
        <Link
          href={`/m/projects/${suggestion.id}`}
          className="font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
        >
          view
        </Link>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await act(() => onLink(suggestion.id), { failed: "Couldn't link it to the project" });
            })
          }
          className="flex items-center gap-1.5 rounded-lg bg-solar/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-solar transition hover:bg-solar/25 disabled:opacity-40"
        >
          <Check className="size-3" />
          {pending ? "…" : "link"}
        </button>
      </div>
    </section>
  );
}
