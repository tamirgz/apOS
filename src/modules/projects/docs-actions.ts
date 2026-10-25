"use server";

import { db } from "@/core/db/client";
import { docHistory, findDoc, lineDiff, listDocs, readDoc } from "./docs";

// Read-only: the Docs tab shows what agents write through the docs.* tools.

export async function listProjectDocs(projectId: string) {
  return listDocs(db, projectId);
}

export async function readProjectDoc(projectId: string, key: string, version?: number) {
  const r = await readDoc(db, projectId, key, version);
  if (!r || "missing" in r) return null;
  return { key, title: r.title, version: r.version, latestVersion: r.doc.version, body: r.body, deleted: !!r.doc.deletedAt };
}

export async function projectDocHistory(projectId: string, key: string) {
  const doc = await findDoc(db, projectId, key);
  if (!doc) return [];
  return (await docHistory(db, doc.id)).map(({ body, ...v }) => ({ ...v, sizeBytes: Buffer.byteLength(body, "utf8") }));
}

export async function diffProjectDoc(projectId: string, key: string, from: number, to: number) {
  const [a, b] = await Promise.all([readDoc(db, projectId, key, from), readDoc(db, projectId, key, to)]);
  if (!a || !b || "missing" in a || "missing" in b) return null;
  return lineDiff(a.body, b.body);
}

export async function listProjectDecisions(projectId: string) {
  const { listDecisions, presentDecisions } = await import("./decisions");
  const { rows } = await listDecisions(db, projectId, { includeSuperseded: true, limit: 2000 });
  return presentDecisions(db, rows);
}
