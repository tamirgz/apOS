import { desc, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { memoryEntries } from "@/core/db/schema/memory";
import { searchIndex } from "@/core/db/schema/search-index";
import { listMemoryBlocks, MAX_INJECTED_CHARS, PROTECTED_BLOCKS, renderMemoryContext } from "@/core/memory";
import { MemoryView } from "../components/MemoryView";
import { SettingsNav } from "../components/SettingsNav";

/** Settings · Memory — the three layers (core · archive · library) and the Lens. */
export async function MemoryPage() {
  const [blocks, entries, library, rendered] = await Promise.all([
    listMemoryBlocks().catch(() => []),
    db
      .select({
        id: memoryEntries.id,
        kind: memoryEntries.kind,
        source: memoryEntries.source,
        text: dsql<string>`left(${memoryEntries.text}, 600)`,
        createdAt: memoryEntries.createdAt,
      })
      .from(memoryEntries)
      .orderBy(desc(memoryEntries.createdAt))
      .limit(2000)
      .catch(() => []),
    db
      .select({ kind: searchIndex.kind, n: dsql<number>`count(*)::int` })
      .from(searchIndex)
      .where(inArray(searchIndex.kind, ["vault", "knowledge", "note"]))
      .groupBy(searchIndex.kind)
      .catch(() => []),
    renderMemoryContext(),
  ]);
  // Injection order: the protected core first, then the rest — the order the
  // budget is filled in, so the bar reads left-to-right like the prompt.
  const rank = (l: string) => (PROTECTED_BLOCKS.includes(l) ? PROTECTED_BLOCKS.indexOf(l) : PROTECTED_BLOCKS.length);
  const ordered = [...blocks].sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));

  return (
    <div className="max-w-6xl">
      <SettingsNav />
      <MemoryView
        blocks={ordered}
        entries={entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }))}
        library={Object.fromEntries(library.map((r) => [r.kind, Number(r.n)]))}
        injected={rendered.length}
        budget={MAX_INJECTED_CHARS}
        protectedLabels={PROTECTED_BLOCKS}
      />
    </div>
  );
}
