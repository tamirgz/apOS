import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { getConnections } from "@/core/embeddings";
import { ConnectionsPanel } from "@/core/ui/ConnectionsPanel";
import { KnowledgeDetail } from "../components/KnowledgeDetail";
import { knowledgeItems } from "../schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function KnowledgeDetailPage({ params }: ModuleRouteProps) {
  const id = params[0];
  const [item] = UUID_RE.test(id)
    ? await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id))
    : [];

  if (!item) {
    return (
      <GlassPanel className="px-8 py-16 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          item not found
        </p>
        <Link
          href="/m/knowledge"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          back to knowledge
        </Link>
      </GlassPanel>
    );
  }
  const { related } = await getConnections("knowledge", item.id);

  return (
    <>
      <KnowledgeDetail item={item} />
      <div className="mt-4 max-w-3xl">
        <ConnectionsPanel related={related} />
      </div>
    </>
  );
}
