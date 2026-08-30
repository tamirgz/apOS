import { and, eq, inArray, lt, sql as dsql } from "drizzle-orm";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { extractText } from "./file-extract";
import { projectFiles } from "./schema";

async function setStatus(id: string, patch: Record<string, unknown>) {
  await db
    .update(projectFiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projectFiles.id, id));
  await sql.notify("project_files_changed", id);
}

/**
 * Extract text from an uploaded file. Runs in the worker (LISTEN
 * "project_file_ingest", payload = file id) — kept off the request thread
 * since PDF/DOCX parsing can take a couple of seconds.
 */
export async function processProjectFile(fileId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.id, fileId));
  if (!row || row.status !== "processing") return;

  try {
    const result = await extractText(row.filename, row.mimeType, row.content);
    await setStatus(fileId, {
      status: result.status,
      statusDetail: result.detail ?? null,
      extractedText: result.text,
    });
  } catch (e) {
    // A parser throw (corrupt PDF etc.) must land in 'error', not stay in
    // 'processing' — the reconcile job would otherwise re-queue the same
    // poison file every 10 minutes forever (knowledge pipeline parity).
    await setStatus(fileId, {
      status: "error",
      statusDetail: String(e).slice(0, 300),
      extractedText: null,
    });
  }
}

export const projectFilesJobs: ModuleJob[] = [
  {
    channel: "project_file_ingest",
    handle: (payload) => processProjectFile(payload),
  },
  {
    // Recovery: a file interrupted mid-extraction (e.g. a worker restart)
    // would otherwise sit in "processing" forever with no re-delivery.
    // Re-queue anything stuck for >10 min — mirrors the knowledge pipeline's
    // reconcile job (same failure mode, same fix).
    channel: "project_files_reconcile",
    schedule: "*/10 * * * *",
    handle: async () => {
      const stuck = await db
        .select({ id: projectFiles.id })
        .from(projectFiles)
        .where(
          and(
            inArray(projectFiles.status, ["processing"]),
            lt(projectFiles.updatedAt, dsql`now() - interval '10 minutes'`),
          ),
        );
      for (const s of stuck) await sql.notify("project_file_ingest", s.id);
    },
  },
];
