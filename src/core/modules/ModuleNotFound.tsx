import Link from "next/link";
import { GlassPanel } from "@/core/ui/GlassPanel";

export function ModuleNotFound({ path }: { path: string }) {
  return (
    <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
        signal lost
      </p>
      <h2 className="font-display text-3xl font-semibold text-ink">
        No module answers at <code className="text-ion">/{path}</code>
      </h2>
      <Link
        href="/m/today"
        className="mt-2 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
      >
        return to today
      </Link>
    </GlassPanel>
  );
}
