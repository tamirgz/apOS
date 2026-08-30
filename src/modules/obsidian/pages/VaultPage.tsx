import Link from "next/link";
import { desc } from "drizzle-orm";
import { BookOpen } from "lucide-react";
import { db } from "@/core/db/client";
import { getSetting } from "@/core/app-settings";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { obsidianNotes } from "../schema";
import { OBSIDIAN_PATH_KEY, vaultStats } from "../sync";
import { VaultControls } from "../components/VaultControls";

export async function VaultPage() {
  const [root, stats, recent] = await Promise.all([
    getSetting(OBSIDIAN_PATH_KEY),
    vaultStats(),
    db
      .select()
      .from(obsidianNotes)
      .orderBy(desc(obsidianNotes.mtime))
      .limit(12),
  ]);

  if (!root) {
    return (
      <GlassPanel className="flex flex-col items-center gap-3 px-8 py-16 text-center">
        <BookOpen className="size-6 text-violet" />
        <h2 className="font-display text-2xl font-semibold text-ink">
          No vault linked
        </h2>
        <p className="max-w-md text-sm text-ink-dim">
          Set your Obsidian vault folder in{" "}
          <Link href="/m/settings/connections" className="text-plasma hover:underline">
            Settings → integrations
          </Link>{" "}
          (the folder that contains your .md notes). apOS indexes it read-only
          — semantic search and agents will answer from your notes; nothing is
          ever written to the vault.
        </p>
      </GlassPanel>
    );
  }

  return (
    <div className="max-w-3xl">
      <VaultControls
        root={root}
        total={stats.total}
        embedded={stats.embedded}
        lastSync={stats.lastSync?.toISOString() ?? null}
      />
      <p className="mb-3 mt-6 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        recently modified in vault
      </p>
      {recent.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/6 py-10 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          index empty — first sync runs within 30 min, or hit sync now
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {recent.map((n) => (
            <a
              key={n.id}
              href={`obsidian://open?path=${encodeURIComponent(n.path)}`}
              className="group glass flex items-center gap-3 rounded-xl px-4 py-2.5 transition hover:bg-white/4"
            >
              <BookOpen className="size-3.5 shrink-0 text-violet" />
              <span className="flex-1 truncate text-sm text-ink-dim transition group-hover:text-ink">
                {n.title}
              </span>
              <span className="font-mono text-[9px] text-ink-faint">
                {n.mtime.toLocaleDateString()}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
