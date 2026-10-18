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

// 3. Every parked row still awaiting execution parses against its tool today.
const rows = await sql`select id, tool_name, input from approvals where status in ('pending','approved')`;
for (const r of rows) {
  const err = parses(r.tool_name, r.input);
  rec(`stored ${r.tool_name} ${String(r.id).slice(0, 8)}`, !err, err ?? "");
}

for (const r of R) console.log(`${r.pass ? "✓" : "✗"} ${r.n}${r.d ? ` — ${r.d}` : ""}`);
const failed = R.filter((r) => !r.pass).length;
console.log(`\n${R.length - failed}/${R.length} passed`);
process.exit(failed ? 1 : 0);
