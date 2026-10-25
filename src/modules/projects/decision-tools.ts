/**
 * Agent tools for project decisions (decisions.ts): the user's decisions as
 * typed records — question, answer, notes, when, items — queried project-wide.
 * Same conventions as the docs tools: a project is named by NAME or key.
 */
import { z } from "zod";
import type { AiToolContext, AiToolDef } from "@/core/modules/types.server";
import { actorOf, resolveProject, resolveTask } from "@/modules/tasks/tools";
import { findDecision, listDecisions, presentDecisions, recordDecision, updateDecision } from "./decisions";

const PROJECT = z.string().min(1).describe("Project NAME or key (e.g. ETHOS-Sec or ES) — never an id");
const NUMBER = z
  .union([z.number().int().min(1), z.string().regex(/^[Dd]?\d+$/)])
  .describe("The decision's number within the project: 12 or 'D12'");
const ITEMS = z.array(z.string().min(1)).describe("Work items by identifier (ES-217) or ref (t3)");
const num = (v: number | string) => (typeof v === "number" ? v : Number(v.replace(/^[Dd]/, "")));
const WHEN = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:?\d{2})?)?$/, "an ISO date or date-time");
const date = (s: string) => new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || s.length === 10 ? s : `${s}Z`);

async function projectOf(ctx: AiToolContext, name: string) {
  const p = await resolveProject(ctx, name);
  return p ?? { error: `No project "${name}"` };
}

/** Resolve item refs to ids; the first one that doesn't resolve is an error. */
async function taskIdsOf(ctx: AiToolContext, refs: string[] | undefined): Promise<string[] | { error: string }> {
  const ids: string[] = [];
  for (const r of refs ?? []) {
    const t = await resolveTask(ctx, r);
    if ("error" in t) return t;
    ids.push(t.id);
  }
  return ids;
}

export const decisionTools: AiToolDef[] = [
  {
    name: "decisions.record",
    description:
      "Record a decision the USER made — the question put to them, their answer, optional notes (rationale, conditions), when they decided, and the work items it concerns. Never record your own choice or recommendation as a decision. " +
      "Numbered per project (D1, D2…). When the user changes an earlier decision, record the new one with `supersedes` — the old one stays readable but leaves default lists. " +
      "Pass `source` (your own stable id for the record, e.g. from an import) to make the call idempotent: the same source returns the existing decision instead of a duplicate.",
    input: z.object({
      project: PROJECT,
      question: z.string().min(1),
      answer: z.string().min(1),
      notes: z.string().optional(),
      decidedAt: WHEN.optional().describe("When the user decided (ISO date or date-time; UTC when no offset). Defaults to now."),
      items: ITEMS.optional(),
      supersedes: NUMBER.optional(),
      source: z.string().min(1).max(200).optional(),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const taskIds = await taskIdsOf(ctx, input.items);
      if ("error" in taskIds) return taskIds;
      const r = await recordDecision(ctx.db, {
        projectId: p.id,
        question: input.question,
        answer: input.answer,
        notes: input.notes,
        decidedAt: input.decidedAt ? date(input.decidedAt) : undefined,
        taskIds,
        source: input.source,
        supersedes: input.supersedes === undefined ? undefined : num(input.supersedes),
        actor: actorOf(ctx),
      });
      if ("error" in r) return r;
      const [d] = await presentDecisions(ctx.db, [r.decision]);
      return {
        ...(r.existing ? { alreadyRecorded: d } : { recorded: d }),
        ...(r.superseded ? { superseded: `D${r.superseded}` } : {}),
      };
    },
  },
  {
    name: "decisions.list",
    description:
      "Query a project's decisions, newest first: all of them, or those on one work item, matching text (question, answer or notes), or decided in a date range. Superseded decisions are left out unless includeSuperseded. Returns {total, decisions}.",
    input: z.object({
      project: PROJECT,
      item: z.string().min(1).optional().describe("Only decisions on this work item (identifier or ref)"),
      q: z.string().min(1).optional().describe("Text to find in the question, answer or notes"),
      since: WHEN.optional().describe("Decided at or after (ISO date or date-time)"),
      until: WHEN.optional().describe("Decided before (ISO date or date-time)"),
      includeSuperseded: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      let taskId: string | undefined;
      if (input.item) {
        const t = await resolveTask(ctx, input.item);
        if ("error" in t) return t;
        taskId = t.id;
      }
      const { rows, total } = await listDecisions(ctx.db, p.id, {
        taskId,
        text: input.q,
        since: input.since ? date(input.since) : undefined,
        until: input.until ? date(input.until) : undefined,
        includeSuperseded: input.includeSuperseded,
        limit: input.limit,
        offset: input.offset,
      });
      return { total, ...(input.offset + rows.length < total ? { more: true } : {}), decisions: await presentDecisions(ctx.db, rows) };
    },
  },
  {
    name: "decisions.get",
    description: "Read one project decision by number (12 or 'D12'), including which decision superseded it, if any.",
    input: z.object({ project: PROJECT, decision: NUMBER }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const d = await findDecision(ctx.db, p.id, num(input.decision));
      if (!d) return { error: `No decision D${num(input.decision)} in that project` };
      return (await presentDecisions(ctx.db, [d]))[0];
    },
  },
  {
    name: "decisions.update",
    description:
      "Correct a recorded decision — fix its wording or date, or link/unlink work items. Not for a changed decision: when the user decides differently, record the new decision with `supersedes` so the history stays.",
    input: z.object({
      project: PROJECT,
      decision: NUMBER,
      question: z.string().min(1).optional(),
      answer: z.string().min(1).optional(),
      notes: z.string().nullable().optional().describe("New notes; null clears them"),
      decidedAt: WHEN.optional(),
      addItems: ITEMS.optional(),
      removeItems: ITEMS.optional(),
    }),
    async execute(input, ctx) {
      const p = await projectOf(ctx, input.project);
      if ("error" in p) return p;
      const add = await taskIdsOf(ctx, input.addItems);
      if ("error" in add) return add;
      const remove = await taskIdsOf(ctx, input.removeItems);
      if ("error" in remove) return remove;
      const row = await updateDecision(
        ctx.db,
        p.id,
        num(input.decision),
        {
          question: input.question,
          answer: input.answer,
          notes: input.notes,
          decidedAt: input.decidedAt ? date(input.decidedAt) : undefined,
          addTaskIds: add,
          removeTaskIds: remove,
        },
        actorOf(ctx),
      );
      if (!row) return { error: `No decision D${num(input.decision)} in that project` };
      return { updated: (await presentDecisions(ctx.db, [row]))[0] };
    },
  },
];
