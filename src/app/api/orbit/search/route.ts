import { sql as dsql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { embedText } from "@/core/embeddings";

/**
 * Semantic search for the Orbit graph. Embeds the query with the same local
 * nomic model as the corpus and returns the nearest search_index rows BY ROW ID
 * — the id space the graph's nodes and links use (searchEverything() returns
 * source_id, a different space, so it can't drive node highlighting here).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return Response.json({ hits: [] });
  let vec: string;
  try {
    vec = `[${(await embedText(q)).join(",")}]`;
  } catch {
    return Response.json({ hits: [], error: "embed_failed" }, { status: 503 });
  }
  const rows = await db.execute<{ id: string; dist: number }>(dsql`
    select id::text as id, (embedding <=> ${vec}::vector)::float8 as dist
      from search_index
     where embedding is not null
     order by dist asc
     limit 40
  `);
  return Response.json({
    hits: [...rows].map((r) => ({ id: r.id, dist: Number(r.dist) })),
  });
}
