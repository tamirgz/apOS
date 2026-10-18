/**
 * Approval-queue contract test: whatever parks a call in `approvals` must park
 * an input the tool's own zod schema accepts — executeApproval parses it with
 * that schema when the user says yes, so a mismatch fails every approval.
 *
 * Run:  pnpm test:approvals        (needs the DB reachable)
 * Exit: non-zero if any shape or stored row fails to parse.
 */
import { sql } from "@/core/db/client";
import { getToolsByNames } from "@/core/ai/tool-registry";
import { openPRInput } from "@/modules/workbench/tools";
import { stabilizeRefs } from "@/core/ai/refs";
import { db } from "@/core/db/client";
import { resolveCycle, resolveTask } from "@/modules/tasks/tools";
import { invokeTool } from "@/core/ai/invoke-tool";
import { z } from "zod";

const R: { n: string; pass: boolean; d: string }[] = [];
const rec = (n: string, pass: boolean, d = "") => R.push({ n, pass, d });
const parses = (name: string, input: unknown) => {
  const tool = getToolsByNames([name])[0];
  if (!tool) return `tool ${name} not registered`;
  try {
    tool.input.parse(input);
    return null;
  } catch (e) {
    return String(e).slice(0, 200);
  }
};

const id = "00000000-0000-4000-8000-000000000001";

// 1. The registered openPR tool validates with the same schema the parkers use.
rec(
  "workbench.openPR uses openPRInput",
  getToolsByNames(["workbench.openPR"])[0]?.input === openPRInput,
);

// 2. The shapes queuePrApproval (routine) and requestPR (manual) park.
for (const [n, input] of [
  ["routine PR shape", { taskId: id, title: "t", body: "b", prBranch: `aios/routine-${id}`, routineId: id }],
  ["manual PR shape", { taskId: id, title: "t", body: "b" }],
] as const) {
  const err = parses("workbench.openPR", input);
  rec(n, !err, err ?? "");
}

// 3. A parked call carries stable ids, and the resolvers accept them with a
//    fresh (ref-less) context — the one executeApproval runs in.
const tid = "00000000-0000-4000-8000-0000000000aa";
const runCtx: any = { db, refs: { t3: { kind: "task", id: tid, name: "x" }, ms1: { kind: "milestone", id, name: "m" } } };
const parked = stabilizeRefs(runCtx, { ref: "t3", nested: { milestone: "MS1" }, list: ["t3", "keep"], note: "t3 stays in prose" });
rec(
  "stabilizeRefs swaps handles for ids",
  JSON.stringify(parked) === JSON.stringify({ ref: tid, nested: { milestone: id }, list: [tid, "keep"], note: "t3 stays in prose" }),
  JSON.stringify(parked),
);
const fresh: any = { db, refs: {} };
const rt = await resolveTask(fresh, tid);
rec("resolveTask accepts a uuid without refs", "id" in rt && rt.id === tid, JSON.stringify(rt));
const [cyc] = await sql`select id from cycles limit 1`;
if (cyc) {
  const rc = await resolveCycle(fresh, null, cyc.id);
  rec("resolveCycle accepts a uuid without refs", "id" in rc && rc.id === cyc.id, JSON.stringify(rc));
}

// 4. invokeTool is the gate: an approval-tier call runs only with a user present
//    or an approval in hand; anywhere else it is parked (fail closed).
let ran = 0;
const probe: any = { name: "zz.probe", description: "", risk: "approval", input: z.object({ ref: z.string() }), execute: async () => ++ran };
const parkedOut: any = await invokeTool(probe, { ref: "t3" }, { db, refs: runCtx.refs } as any);
rec("unattended approval-tier call is parked", ran === 0 && typeof parkedOut?.pending_approval === "string", JSON.stringify(parkedOut));
if (parkedOut?.pending_approval) {
  const [row] = await sql`select input, agent_name from approvals where id = ${parkedOut.pending_approval}`;
  rec("parked row carries stable ids", row?.input?.ref === tid, JSON.stringify(row));
  await sql`delete from approvals where id = ${parkedOut.pending_approval}`;
  await sql`delete from notifications where title = 'Approval needed: zz.probe'`;
}
await invokeTool(probe, { ref: "x" }, { db, userPresent: true } as any);
rec("user-present call executes", ran === 1);
await invokeTool(probe, { ref: "x" }, { db, approved: true } as any);
rec("approved call executes", ran === 2);
await invokeTool({ ...probe, risk: "safe" }, { ref: "x" }, { db } as any);
rec("safe call executes", ran === 3);
const delegateTool = getToolsByNames(["workbench.delegate"])[0];
rec("workbench.delegate is approval-tier", delegateTool?.risk === "approval");

// 5. Every parked row still awaiting execution parses against its tool today.
const rows = await sql`select id, tool_name, input from approvals where status in ('pending','approved')`;
for (const r of rows) {
  const err = parses(r.tool_name, r.input);
  rec(`stored ${r.tool_name} ${String(r.id).slice(0, 8)}`, !err, err ?? "");
}

for (const r of R) console.log(`${r.pass ? "✓" : "✗"} ${r.n}${r.d ? ` — ${r.d}` : ""}`);
const failed = R.filter((r) => !r.pass).length;
console.log(`\n${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
