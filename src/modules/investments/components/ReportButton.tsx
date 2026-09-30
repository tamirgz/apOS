"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { act } from "@/core/ui/feedback";
import { createInvestmentReport } from "../report";

/** Spawns a deep investment report as a Workbench task and opens it. */
export function ReportButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await act(createInvestmentReport, { failed: "Couldn't start the investment report" });
          if (!r.ok) return;
          router.push(`/m/workbench/${r.value.id}`);
        })
      }
      title="Generate a thorough, structured investment report as a background run"
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/6 hover:text-ink disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <FileText className="size-3" />
      )}
      deep report
    </button>
  );
}
