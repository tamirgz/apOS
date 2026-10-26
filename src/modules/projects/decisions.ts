/**
 * Project decisions (schema: projectDecisions) — the user's decisions as typed
 * records, queryable by item, text and date instead of read out of a doc.
 */
import { and, arrayContains, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { identifierOf, nextNumber, projectKeyMap } from "@/modules/tasks/core";
import { tasks } from "@/modules/tasks/schema";
import { projectDecisions, type ProjectDecision } from "./schema";

export const decisionScope = (projectId: string) => `decisions:${projectId}`;

export interface DecisionInput {
  projectId: string;
  question: string;
  answer: string;
  notes?: string | null;
  decidedAt?: Date;
  taskIds?: string[];
  source?: string | null;
  /** The number of an earlier decision this one replaces. */
  supersedes?: number;
  actor: string;
}

export async function findDecision(db: Db, projectId: string, number: number) {
  const [d] = await db
    .select()
    .from(projectDecisions)
    .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.number, number)));
  return d ?? null;
}

/**
 * Record a decision. Idempotent on `source`: a second record with the same
 * source returns the first, untouched, as `{decision, existing: true}`.
 */
export async function recordDecision(
  db: Db,
  input: DecisionInput,
): Promise<{ decision: ProjectDecision; existing?: true; superseded?: number } | { error: string }> {
  if (input.source) {
    const [dup] = await db
      .select()
      .from(projectDecisions)
      .where(and(eq(projectDecisions.projectId, input.projectId), eq(projectDecisions.source, input.source)));
    if (dup) return { decision: dup, existing: true };
  }
  const old = input.supersedes !== undefined ? await findDecision(db, input.projectId, input.supersedes) : null;
  if (input.supersedes !== undefined && !old) return { error: `No decision D${input.supersedes} in that project` };
  if (old?.deletedAt) return { error: `D${old.number} is deleted` };
  if (old?.supersededBy) return { error: `D${old.number} is already superseded` };
  const number = await nextNumber(db, decisionScope(input.projectId));
  const [decision] = await db
    .insert(projectDecisions)
    .values({
      projectId: input.projectId,
      number,
      question: input.question.trim(),
      answer: input.answer.trim(),
      notes: input.notes?.trim() || null,
      decidedAt: input.decidedAt ?? new Date(),
      taskIds: [...new Set(input.taskIds ?? [])],
      source: input.source || null,
      createdBy: input.actor,
      updatedBy: input.actor,
    })
    .returning();
  if (old) {
    await db
      .update(projectDecisions)
      .set({ supersededBy: decision.id, updatedBy: input.actor, updatedAt: new Date() })
      .where(eq(projectDecisions.id, old.id));
  }
  return { decision, ...(old ? { superseded: old.number } : {}) };
}

export interface DecisionPatch {
  question?: string;
  answer?: string;
  notes?: string | null;
  decidedAt?: Date;
  addTaskIds?: string[];
  removeTaskIds?: string[];
}

/** Correct a recorded decision (a typo, a missing item link). A changed decision is a new one: record it with `supersedes`. */
export async function updateDecision(db: Db, projectId: string, number: number, patch: DecisionPatch, actor: string) {
  const cur = await findDecision(db, projectId, number);
  if (!cur || cur.deletedAt) return null;
  const drop = new Set(patch.removeTaskIds ?? []);
  const taskIds = [...new Set([...cur.taskIds, ...(patch.addTaskIds ?? [])])].filter((id) => !drop.has(id));
  const [row] = await db
    .update(projectDecisions)
    .set({
      ...(patch.question !== undefined ? { question: patch.question.trim() } : {}),
      ...(patch.answer !== undefined ? { answer: patch.answer.trim() } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
      ...(patch.decidedAt ? { decidedAt: patch.decidedAt } : {}),
      taskIds,
      updatedBy: actor,
      updatedAt: new Date(),
    })
    .where(eq(projectDecisions.id, cur.id))
    .returning();
  return row;
}

/**
 * Soft-delete a decision (a duplicate, a ruling recorded by mistake): it leaves
 * every list but stays readable by number with who deleted it and when, and it
 * keeps its `source`, so re-running an import doesn't bring it back. A decision
 * it superseded becomes current again — reported as `reinstated`.
 */
export async function deleteDecision(
  db: Db,
  projectId: string,
  number: number,
  actor: string,
): Promise<{ decision: ProjectDecision; reinstated: number[] } | { error: string } | null> {
  return db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(projectDecisions)
      .where(and(eq(projectDecisions.projectId, projectId), eq(projectDecisions.number, number)))
      .for("update");
    if (!cur) return null;
    if (cur.deletedAt) return { error: `D${number} is already deleted (by ${cur.deletedBy}, ${cur.deletedAt.toISOString()})` };
    const now = new Date();
    const [decision] = await tx
      .update(projectDecisions)
      .set({ deletedAt: now, deletedBy: actor, updatedBy: actor, updatedAt: now })
      .where(eq(projectDecisions.id, cur.id))
      .returning();
    const reinstated = await tx
      .update(projectDecisions)
      .set({ supersededBy: null, updatedBy: actor, updatedAt: now })
      .where(eq(projectDecisions.supersededBy, cur.id))
      .returning({ number: projectDecisions.number });
    return { decision, reinstated: reinstated.map((r) => r.number) };
  });
}

export interface DecisionQuery {
  taskId?: string;
  /** Matched case-insensitively against question, answer and notes. */
  text?: string;
  since?: Date;
  until?: Date;
  includeSuperseded?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

/** A project's decisions, newest first, with the total that matched. */
export async function listDecisions(db: Db, projectId: string, q: DecisionQuery = {}) {
  const where: (SQL | undefined)[] = [eq(projectDecisions.projectId, projectId)];
  if (!q.includeSuperseded) where.push(isNull(projectDecisions.supersededBy));
  if (!q.includeDeleted) where.push(isNull(projectDecisions.deletedAt));
  if (q.taskId) where.push(arrayContains(projectDecisions.taskIds, [q.taskId]));
  if (q.since) where.push(gte(projectDecisions.decidedAt, q.since));
  if (q.until) where.push(lt(projectDecisions.decidedAt, q.until));
  if (q.text?.trim()) {
    const like = `%${q.text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(
        sql`${projectDecisions.question} ilike ${like}`,
        sql`${projectDecisions.answer} ilike ${like}`,
        sql`${projectDecisions.notes} ilike ${like}`,
      ),
    );
  }
  const cond = and(...where);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(projectDecisions)
      .where(cond)
      .orderBy(desc(projectDecisions.decidedAt), desc(projectDecisions.number))
      .limit(q.limit ?? 50)
      .offset(q.offset ?? 0),
    db.select({ total: sql<number>`count(*)::int` }).from(projectDecisions).where(cond),
  ]);
  return { rows, total };
}

/** Decisions as agents see them: D-numbers and item identifiers, never ids. */
export async function presentDecisions(db: Db, rows: ProjectDecision[]) {
  const ids = [...new Set(rows.flatMap((d) => d.taskIds))];
  const supersedingIds = rows.flatMap((d) => (d.supersededBy ? [d.supersededBy] : []));
  const [items, keys, successors] = await Promise.all([
    ids.length ? db.select({ id: tasks.id, projectRef: tasks.projectRef, number: tasks.number }).from(tasks).where(inArray(tasks.id, ids)) : [],
    projectKeyMap(db),
    supersedingIds.length
      ? db.select({ id: projectDecisions.id, number: projectDecisions.number }).from(projectDecisions).where(inArray(projectDecisions.id, supersedingIds))
      : [],
  ]);
  const ident = new Map(items.map((t) => [t.id, identifierOf(t, keys)]));
  const next = new Map(successors.map((s) => [s.id, s.number]));
  return rows.map((d) => ({
    ref: `D${d.number}`,
    decidedAt: d.decidedAt,
    question: d.question,
    answer: d.answer,
    ...(d.notes ? { notes: d.notes } : {}),
    items: d.taskIds.map((id) => ident.get(id) ?? "(deleted item)"),
    ...(d.supersededBy ? { supersededBy: `D${next.get(d.supersededBy) ?? "?"}` } : {}),
    ...(d.source ? { source: d.source } : {}),
    recordedBy: d.createdBy,
    ...(d.deletedAt ? { deleted: { at: d.deletedAt, by: d.deletedBy } } : {}),
  }));
}

export type DecisionView = Awaited<ReturnType<typeof presentDecisions>>[number];
