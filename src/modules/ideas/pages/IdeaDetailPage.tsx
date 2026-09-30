import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { ModuleRouteProps } from "@/core/modules/types.server";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { getConnections } from "@/core/embeddings";
import { IdeaDetail } from "../components/IdeaDetail";
import { IdeaConnections } from "../components/IdeaConnections";
import { ideas } from "../schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function IdeaDetailPage({ params }: ModuleRouteProps) {
  const id = params[0];
  const [idea] = UUID_RE.test(id)
    ? await db.select().from(ideas).where(eq(ideas.id, id))
    : [];

  if (!idea) {
    return (
      <GlassPanel className="px-8 py-16 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
          idea not found
        </p>
        <Link
          href="/m/ideas"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:bg-white/5 hover:text-ink"
        >
          <ArrowLeft className="size-3.5" />
          back to ideas
        </Link>
      </GlassPanel>
    );
  }
  const connections = await getConnections("idea", idea.id, {
    currentProjectId: idea.projectRef?.split(":")[1] ?? null,
  });

  return (
    <>
      <IdeaDetail idea={idea} />
      <div className="max-w-3xl">
        <IdeaConnections ideaId={idea.id} connections={connections} />
      </div>
    </>
  );
}
