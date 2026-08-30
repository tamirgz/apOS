import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector column, declared dimension-less at the DDL level. The embedding
 * model is user-configurable (Settings → embedding model) and models differ in
 * output dimensions (nomic-embed-text = 768, bge-m3 = 1024 …).
 *
 * At RUNTIME the worker pins `search_index.embedding` to the active model's
 * dimension and maintains an HNSW index on it (ensureVectorIndex in
 * core/embeddings.ts) — a typmod-less column can't be indexed, which made
 * every similarity query a sequential scan. On a model switch the column is
 * re-altered to the new dimension and the corpus re-embeds. Don't let
 * drizzle-kit "correct" the live column back to dimension-less.
 */
export const embeddingVector = customType<{ data: unknown }>({
  dataType() {
    return "vector";
  },
});
