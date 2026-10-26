/**
 * Work tracker smoke-test — the P2 pieces end to end against the live schema:
 * commit-message scanning + commit linking/closing, relations (+ the blocked
 * set), cycles + burndown + roll-over, Workbench write-back, and the Plane
 * importer driven by the saved fixture (twice, to prove it's idempotent).
 *
 * Run:  npx tsx --env-file=.env.local scripts/test-work.mts
 * Exit: non-zero on any failure. Throwaway rows are prefixed ZZ and removed on
 * teardown. Never starts a real Workbench run (the run row is inserted without
 * an attempt, so the worker has nothing to execute).
 */
import assert from "node:assert/strict";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { features, projectDecisions, projects } from "@/modules/projects/schema";
import { workbenchTasks } from "@/modules/workbench/schema";
import {
  addLink,
  addRelation,
  blockedItemIds,
  createWorkItem,
  deleteWorkItem,
  getWorkItem,
  listRelations,
  updateWorkItem,
} from "@/modules/tasks/core";
import { applyCommits, commitUrl, parseLog, scanMessage } from "@/modules/tasks/commits";
import { burndown, createCycle, cycleGhosts, cycleStatus, deleteCycle, listCycles, reconcileDoneCycles, rollOverCycle } from "@/modules/tasks/cycles";
import { syncFromWorkbench } from "@/modules/tasks/delegate";
import { importPlane, previewPlane, Progress } from "@/modules/tasks/plane/import";
import { apiBaseFrom } from "@/modules/tasks/plane/client";
import { htmlToText, mapModuleStatus, mapState } from "@/modules/tasks/plane/map";
import { cycles, milestoneCapabilities, milestoneContent, milestones, taskActivity, taskLinks, tasks } from "@/modules/tasks/schema";
import fixture from "../src/modules/tasks/plane/__fixtures__/responses.json" with { type: "json" };

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

const DAY = 86_400_000;
const projectIds: string[] = [];
const wbIds: string[] = [];

async function zzProject(name: string, key: string) {
  const [p] = await db.insert(projects).values({ name, key }).returning();
  projectIds.push(p.id);
  return p;
}

console.log("pure");
await check("scanMessage: mentions, closes, lists", () => {
  assert.deepEqual(scanMessage("Fixes ZZA-1, ZZA-2 and ZZB-3"), { mentions: ["ZZA-1", "ZZA-2", "ZZB-3"], closes: ["ZZA-1", "ZZA-2", "ZZB-3"] });
  assert.deepEqual(scanMessage("refs ZZA-1; resolved ZZA-004").closes, ["ZZA-4"]);
  assert.deepEqual(scanMessage("fixes zza-1 lowercase").mentions, []);
  assert.deepEqual(scanMessage("T-1000 is not an item").mentions, []);
});
await check("commitUrl: https + ssh remotes, local path → null", () => {
  assert.equal(commitUrl("https://github.com/o/r.git", "abc"), "https://github.com/o/r/commit/abc");
  assert.equal(commitUrl("git@github.com:o/r.git", "abc"), "https://github.com/o/r/commit/abc");
  assert.equal(commitUrl("/Users/x/repo", "abc"), null);
});
await check("plane mappers", () => {
  assert.equal(mapState({ id: "", name: "In Review", group: "started" }), "review");
  assert.equal(mapState({ id: "", name: "Doing", group: "started" }), "doing");
  assert.equal(mapState({ id: "", name: "x", group: "unstarted" }), "todo");
  assert.equal(mapModuleStatus("in_progress"), "active");
  assert.equal(mapModuleStatus("in-progress"), "active");
  assert.equal(htmlToText("<p>a &amp; b</p><ul><li>x</li><li>y</li></ul>"), "a & b\n- x\n- y");
  assert.equal(apiBaseFrom(""), "https://api.plane.so");
  assert.equal(apiBaseFrom("app.plane.so"), "https://api.plane.so");
  assert.equal(apiBaseFrom("https://plane.example.com/api/v1/"), "https://plane.example.com");
});
await check("cycle status + burndown", () => {
  const now = Date.UTC(2026, 8, 10, 12);
  const c = { startsAt: new Date(Date.UTC(2026, 8, 7)), endsAt: new Date(Date.UTC(2026, 8, 13)) };
  assert.equal(cycleStatus(c, now), "current");
  assert.equal(cycleStatus({ ...c, startsAt: new Date(now + DAY) }, now), "upcoming");
  const b = burndown(
    c,
    [
      { createdAt: new Date(Date.UTC(2026, 8, 1)), completedAt: new Date(Date.UTC(2026, 8, 8, 9)) },
      { createdAt: new Date(Date.UTC(2026, 8, 1)), completedAt: null },
      { createdAt: new Date(Date.UTC(2026, 8, 9, 9)), completedAt: null }, // scope added mid-cycle
    ],
    now,
  );
  assert.deepEqual(b.map((d) => d.remaining), [2, 1, 2, 2]);
});

await check("parseLog: committer date; ghost buckets", () => {
  const sha = "a".repeat(40);
  const [c] = parseLog(`${sha}\x1fzz\x1f2026-10-20T14:51:00+00:00\x1fES-747 fix (#548)\x1fCloses ES-747\x1e`);
  assert.equal(c.at?.toISOString(), "2026-10-20T14:51:00.000Z");
  assert.deepEqual(scanMessage(`${c.subject}\n${c.body}`).closes, ["ES-747"]);
  assert.deepEqual(scanMessage("ES-746 part 1 of 4 (#540)").closes, [], "a leading id only links");
  const cyc = { startsAt: new Date(Date.UTC(2026, 9, 18)), endsAt: new Date(Date.UTC(2026, 9, 24)) };
  const at = (d: number) => new Date(Date.UTC(2026, 9, d, 12));
  const g = cycleGhosts(cyc, [
    { id: "1", status: "done", completedAt: at(24), dueAt: null }, // last day: inside
    { id: "2", status: "done", completedAt: at(12), dueAt: null },
    { id: "3", status: "cancelled", completedAt: at(20), dueAt: null },
    { id: "4", status: "todo", completedAt: null, dueAt: null },
    { id: "5", status: "doing", completedAt: null, dueAt: at(30) },
    { id: "6", status: "doing", completedAt: null, dueAt: at(19) },
  ]);
  assert.deepEqual(g, { cancelled: ["3"], doneOutside: ["2"], undated: ["4"], dueOutside: ["5"] });
});

console.log("db");
try {
  const p = await zzProject("ZZ Work Test", "ZZWT");
  const ref = `projects:${p.id}`;
  const a = await createWorkItem(db, { title: "ZZ a", projectRef: ref, status: "todo" }, "user");
  const b = await createWorkItem(db, { title: "ZZ b", projectRef: ref, status: "todo" }, "user");

  await check("relations: blocked-by reads from both sides; blocked set; no mutual block", async () => {
    await addRelation(db, b.id, "blocked_by", a.id, "user");
    const fromB = await listRelations(db, b.id);
    const fromA = await listRelations(db, a.id);
    assert.equal(fromB[0].side, "blocked_by");
    assert.equal(fromA[0].side, "blocks");
    assert.ok((await blockedItemIds(db)).has(b.id));
    await assert.rejects(addRelation(db, a.id, "blocked_by", b.id, "user"), /block each other/);
    await updateWorkItem(db, a.id, { status: "done" }, "user");
    assert.ok(!(await blockedItemIds(db)).has(b.id), "closing the blocker unblocks");
  });

  await check("commits: link on mention, close on 'fixes', no re-close on rescan", async () => {
    const sha1 = "1".repeat(40);
    const sha2 = "2".repeat(40);
    const r = await applyCommits(
      db,
      [
        { sha: sha2, author: "zz", subject: `fix: thing (fixes ${b.identifier})`, body: "", at: new Date("2026-10-20T14:51:00Z") },
        { sha: sha1, author: "zz", subject: `wip on ${b.identifier}`, body: "" },
      ],
      { repoUrl: "https://github.com/zz/zz.git", allowClose: true, closeProjectRefs: [ref] },
    );
    assert.deepEqual(r, { linked: 2, closed: 1 });
    const d = await getWorkItem(db, b.id);
    assert.equal(d!.item.status, "done");
    assert.equal(d!.item.completedAt?.toISOString(), "2026-10-20T14:51:00.000Z", "done as of the commit, not the scan");
    assert.equal(d!.links.filter((l) => l.kind === "commit").length, 2);
    assert.ok(d!.activity.some((x) => x.actor === "system:commit" && x.kind === "comment"));
    await updateWorkItem(db, b.id, { status: "todo" }, "user");
    const again = await applyCommits(db, [{ sha: sha2, author: "zz", subject: `fixes ${b.identifier}`, body: "" }], {
      repoUrl: null,
      allowClose: true,
      closeProjectRefs: [ref],
    });
    assert.deepEqual(again, { linked: 0, closed: 0 });
  });

  await check("commits: another project's repo links but never closes", async () => {
    const e = await createWorkItem(db, { title: "ZZ e", projectRef: ref, status: "doing" }, "user");
    const r = await applyCommits(db, [{ sha: "4".repeat(40), author: "zz", subject: `docs: e.g. "Closes ${e.identifier}"`, body: "" }], {
      repoUrl: null,
      allowClose: true,
      closeProjectRefs: ["projects:00000000-0000-0000-0000-000000000000"],
    });
    assert.deepEqual(r, { linked: 1, closed: 0 });
    assert.equal((await getWorkItem(db, e.id))!.item.status, "doing");
  });

  await check("baseline scan links but never closes", async () => {
    const c = await createWorkItem(db, { title: "ZZ c", projectRef: ref }, "user");
    const r = await applyCommits(db, [{ sha: "3".repeat(40), author: "zz", subject: `closes ${c.identifier}`, body: "" }], {
      repoUrl: null,
      allowClose: false,
      closeProjectRefs: [ref],
    });
    assert.deepEqual(r, { linked: 1, closed: 0 });
  });

  await check("cycles: summary, roll-over, delete un-plans", async () => {
    const now = Date.now();
    const done = await createCycle(db, { name: "ZZ c1", startsAt: new Date(now - 20 * DAY), endsAt: new Date(now - 7 * DAY), projectId: p.id });
    const cur = await createCycle(db, { name: "ZZ c2", startsAt: new Date(now - 6 * DAY), endsAt: new Date(now + 7 * DAY), projectId: p.id });
    await updateWorkItem(db, b.id, { cycleId: done.id }, "user");
    await updateWorkItem(db, a.id, { cycleId: done.id }, "user");
    const cycleOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0].cycleId;
    assert.equal(await cycleOf(a.id), cur.id, "a done item planned into a past cycle is filed under the one holding its done date");
    const mine = (await listCycles(db, { projectId: p.id })).find((c) => c.id === done.id)!;
    assert.equal(mine.status, "completed");
    assert.equal(mine.total, 1);
    assert.equal(mine.done, 0);
    assert.equal(await rollOverCycle(db, done.id, cur.id), 1);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].cycleId, cur.id);
    await deleteCycle(db, cur.id);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].cycleId, null);
    await deleteCycle(db, done.id);
  });

  await check("cycles: done items follow their done date (create, close, sweep)", async () => {
    const now = Date.now();
    const past = await createCycle(db, { name: "ZZ past", startsAt: new Date(now - 21 * DAY), endsAt: new Date(now - 15 * DAY), projectId: p.id });
    const cur = await createCycle(db, { name: "ZZ now", startsAt: new Date(now - 3 * DAY), endsAt: new Date(now + 3 * DAY), projectId: p.id });
    try {
      const x = await createWorkItem(db, { title: "ZZ x", projectRef: ref, status: "done", cycleId: past.id }, "user");
      assert.equal(x.cycleId, cur.id, "created done → filed by today's date");
      const y = await createWorkItem(db, { title: "ZZ y", projectRef: ref, status: "doing", cycleId: past.id }, "user");
      await updateWorkItem(db, y.id, { status: "done" }, "user");
      const gy = await getWorkItem(db, y.id);
      assert.equal(gy!.item.cycleId, cur.id, "closing moves it to the cycle of its done date");
      assert.ok(gy!.activity.some((r) => r.field === "cycleId"), "the move is in the item's history");
      // A done item in the wrong cycle from before the rule: the sweep repairs it.
      const z = await createWorkItem(db, { title: "ZZ z", projectRef: ref, status: "todo", cycleId: cur.id }, "user");
      await db.update(tasks).set({ status: "done", completedAt: new Date(now - 18 * DAY) }).where(eq(tasks.id, z.id));
      const stuck = await createWorkItem(db, { title: "ZZ stuck", projectRef: ref, status: "todo", cycleId: cur.id }, "user");
      await db.update(tasks).set({ status: "done", completedAt: new Date(now - 40 * DAY) }).where(eq(tasks.id, stuck.id));
      assert.equal(await reconcileDoneCycles(db, { projectId: p.id }), 1, "only z has a home; stuck has no cycle for its date");
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, z.id)))[0].cycleId, past.id);
      assert.equal(await reconcileDoneCycles(db, { projectId: p.id }), 0, "idempotent");
      const now2 = (await listCycles(db, { projectId: p.id })).find((c) => c.id === cur.id)!;
      assert.equal(now2.ghosts, 1, "the homeless one is reported as a ghost");
    } finally {
      await deleteCycle(db, cur.id);
      await deleteCycle(db, past.id);
    }
  });

  await check("workbench write-back: review → In review once; done → Done", async () => {
    const [wb] = await db
      .insert(workbenchTasks)
      .values({ title: "ZZ run", prompt: "zz", taskType: "research", createdFrom: `tasks:${b.id}`, status: "running" })
      .returning();
    wbIds.push(wb.id);
    await addLink(db, b.id, { kind: "workbench", ref: wb.id, state: "queued" });
    assert.equal(await syncFromWorkbench(db, wb.id), 0, "running writes nothing");
    await db.update(workbenchTasks).set({ status: "review", summary: "ZZ did it" }).where(eq(workbenchTasks.id, wb.id));
    assert.equal(await syncFromWorkbench(db, wb.id), 1);
    assert.equal(await syncFromWorkbench(db, wb.id), 0, "same transition applied once");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].status, "review");
    await db.update(workbenchTasks).set({ status: "done" }).where(eq(workbenchTasks.id, wb.id));
    assert.equal(await syncFromWorkbench(db, wb.id), 1);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].status, "done");
  });

  await check("plane import from fixture: preview, import, idempotent re-import", async () => {
    const F = fixture as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const get = async (path: string) => {
      const pth = path.split("?")[0];
      let m: RegExpMatchArray | null;
      if (pth === "/projects/")
        return { ...F.projects, results: F.projects.results.map((r: { name: string; identifier: string }) => ({ ...r, name: `ZZ Plane ${r.name}`, identifier: `ZZP${r.identifier.slice(0, 2)}` })) };
      if ((m = pth.match(/modules\/([^/]+)\/module-issues/))) return F.module_issues[m[1]] ?? { results: [] };
      if ((m = pth.match(/cycles\/([^/]+)\/cycle-issues/))) return F.cycle_issues[m[1]] ?? { results: [] };
      for (const k of ["states", "labels", "modules", "cycles"]) if (pth.endsWith(`/${k}/`)) return F[k];
      if (pth.endsWith("/work-items/")) return F.work_items;
      throw new Error(`unmapped ${path}`);
    };
    const plan = await previewPlane(db, get, new Progress("preview", false));
    assert.equal(plan.length, 2);
    assert.equal(plan[0].newItems, 4);
    assert.ok(plan[1].archived);
    const r1 = await importPlane(db, get, new Progress("import", false));
    assert.deepEqual(r1, { projects: 1, created: 4, updated: 0, features: 2, cycles: 1 });
    const [pp] = await db.select().from(projects).where(eq(projects.name, "ZZ Plane ETHOS"));
    projectIds.push(pp.id);
    const items = await db.select().from(tasks).where(eq(tasks.projectRef, `projects:${pp.id}`));
    const byTitle = new Map(items.map((t) => [t.title, t]));
    assert.equal(byTitle.get("Session expiry bug")!.status, "review");
    assert.equal(byTitle.get("Session expiry bug")!.parentId, byTitle.get("SSO with Google")!.id);
    assert.deepEqual(byTitle.get("Session expiry bug")!.labels, ["bug", "api-layer"]);
    const [billing] = await db.select().from(features).where(eq(features.name, "Billing v1"));
    assert.equal(billing.status, "shipped");
    // Managed here now: a local edit survives a re-import.
    await db.update(tasks).set({ title: "ZZ edited locally", priority: "low" }).where(eq(tasks.id, byTitle.get("SSO with Google")!.id));
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(taskActivity).where(inArray(taskActivity.taskId, items.map((t) => t.id)));
    const r2 = await importPlane(db, get, new Progress("import", false));
    assert.equal(r2.created, 0);
    const [kept] = await db.select().from(tasks).where(eq(tasks.id, byTitle.get("SSO with Google")!.id));
    assert.equal(kept.title, "ZZ edited locally", "re-import must not overwrite local edits");
    assert.equal(kept.priority, "low");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(taskActivity).where(inArray(taskActivity.taskId, items.map((t) => t.id)));
    assert.equal(after[0].n, before[0].n, "re-import with no Plane changes writes no history");
  });
  await check("apos MCP server: projects, modules, cycles, items, relations over stdio", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "zz-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "scripts/apos-mcp.sh", env: { ...process.env, APOS_ACTOR: "zz-test" } as Record<string, string>, stderr: "ignore" }));
    try {
      const listed = (await client.listTools()).tools;
      const names = listed.map((t) => t.name);
      assert.equal(listed.find((t) => t.name === "cycles__delete")?.annotations?.destructiveHint, true, "cycles.delete is marked destructive");
      for (const n of ["tasks__create", "tasks__relate", "cycles__create", "cycles__delete", "cycles__get", "modules__update", "projects__list", "decisions__record", "decisions__list", "decisions__delete", "docs__delete"]) assert.ok(names.includes(n), `exposes ${n}`);
      assert.ok(!names.includes("memory__update"), "only the work-tracker surface");
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
        return JSON.parse(r.content[0].text);
      };
      const { created: proj } = await call("projects__create", { name: "ZZ MCP Test" });
      projectIds.push(proj.id);
      assert.ok(proj.key, "a new project gets a key");
      const { created: mod } = await call("modules__create", { project: proj.key, name: "ZZ Auth", targetAt: new Date(Date.now() + 14 * DAY).toISOString() });
      assert.equal(mod.ref, "m1");
      const now = Date.now();
      const sunday = new Date(now).setUTCHours(0, 0, 0, 0) - new Date(now).getUTCDay() * DAY; // cycles start on a Sunday
      const { created: cyc } = await call("cycles__create", { project: proj.key, name: "ZZ sprint", startsAt: new Date(sunday).toISOString(), endsAt: new Date(sunday + 6 * DAY).toISOString() });
      assert.equal(cyc.status, "current");
      const a = (await call("tasks__create", { project: proj.key, title: "ZZ login form", feature: "m1", cycle: "current" })).created;
      const b = (await call("tasks__create", { project: proj.key, title: "ZZ session store", feature: "ZZ Auth" })).created;
      assert.match(a.identifier, new RegExp(`^${proj.key}-\\d+$`));
      const inCycle = await call("tasks__list", { project: proj.key, cycle: "current" });
      assert.deepEqual(inCycle.map((t: { title: string }) => t.title), ["ZZ login form"]);
      assert.equal(inCycle[0].module, "ZZ Auth");
      assert.equal(inCycle[0].cycle, "ZZ sprint");
      await call("tasks__relate", { ref: a.identifier, relation: "blocked_by", other: b.identifier });
      await call("tasks__update", { ref: b.identifier, cycle: "ZZ sprint", parent: a.identifier, startAt: new Date(now).toISOString() });
      const got = await call("tasks__get", { ref: b.identifier });
      assert.equal(got.parent.identifier, a.identifier);
      assert.ok(got.activity.some((x: { by: string }) => /^agent:zz-test:zz-test\/0#[0-9a-f]{6}$/.test(x.by)), "activity credits the MCP actor (prefix:client/version#session)");
      await call("modules__update", { module: "m1", status: "paused", startAt: new Date(now).toISOString() });
      const [m] = await call("modules__list", { project: proj.key, status: "all" });
      assert.equal(m.status, "paused");
      assert.equal(m.items, 2);
      const c3 = (await call("tasks__create", { project: proj.key, title: "ZZ dropped", cycle: "ZZ sprint" })).created;
      await call("tasks__setStatus", { ref: c3.identifier, status: "cancelled" });
      const g = await call("cycles__get", { cycle: "ZZ sprint", project: proj.key });
      assert.equal(g.items, 2, "cancelled members are counted nowhere");
      assert.deepEqual(g.ghosts.cancelled.items, [c3.identifier]);
      assert.equal(g.ghosts.undated.count, 2, "open items with no due date");
      assert.equal(g.ghosts.total, 3);
      assert.equal((await call("cycles__list", { project: proj.key })).find((c: { name: string }) => c.name === "ZZ sprint").ghosts, 3);
      assert.equal((await call("cycles__rollOver", { from: "c1" })).moved, 2);
      await call("tasks__update", { ref: a.identifier, cycle: "ZZ sprint" });
      assert.ok((await call("cycles__delete", { cycle: "ZZ sprint" })).pending_approval, "deleting a cycle waits for the user's approval");
      const [sprint] = await db.select().from(cycles).where(and(eq(cycles.projectId, proj.id), eq(cycles.name, "ZZ sprint")));
      await deleteCycle(db, sprint.id); // what approving it runs
      assert.equal((await call("tasks__get", { ref: a.identifier })).cycle ?? null, null, "…never deletes them");
      assert.ok(!(await call("cycles__list", { project: proj.key, include: "all" })).some((c: { name: string }) => c.name === "ZZ sprint"), "the cycle is gone");
      assert.equal((await call("tasks__unrelate", { ref: a.identifier, other: b.identifier })).removed, 1);
      const d1 = (await call("decisions__record", { project: proj.key, question: "ZZ ship on Fridays?", answer: "No", notes: "weekend", decidedAt: "2026-10-05T09:52", items: [a.identifier], source: "zz:1" })).recorded;
      assert.equal(d1.ref, "D1");
      assert.equal(d1.decidedAt, "2026-10-05T09:52:00.000Z", "a date-time without offset is UTC");
      assert.deepEqual(d1.items, [a.identifier]);
      assert.equal((await call("decisions__record", { project: proj.key, question: "dup", answer: "dup", source: "zz:1" })).alreadyRecorded.ref, "D1", "same source → no duplicate");
      await call("decisions__record", { project: proj.key, question: "ZZ use Postgres?", answer: "Yes", decidedAt: "2026-10-07" });
      const d3 = await call("decisions__record", { project: proj.key, question: "ZZ ship on Fridays?", answer: "Yes, before noon", supersedes: "D1", items: [a.identifier] });
      assert.deepEqual([d3.recorded.ref, d3.superseded], ["D3", "D1"]);
      const onA = await call("decisions__list", { project: proj.key, item: a.identifier });
      assert.deepEqual(onA.decisions.map((d: { ref: string }) => d.ref), ["D3"], "superseded ones are out of default lists");
      assert.equal((await call("decisions__list", { project: proj.key, item: a.identifier, includeSuperseded: true })).total, 2);
      assert.equal((await call("decisions__list", { project: proj.key, q: "postgres" })).decisions[0].ref, "D2");
      assert.equal((await call("decisions__list", { project: proj.key, since: "2026-10-06", until: "2026-10-08" })).total, 1);
      assert.equal((await call("decisions__get", { project: proj.key, decision: 1 })).supersededBy, "D3");
      const upd = (await call("decisions__update", { project: proj.key, decision: "D2", addItems: [b.identifier], notes: "cheap" })).updated;
      assert.deepEqual([upd.items, upd.notes], [[b.identifier], "cheap"]);
      assert.ok((await client.callTool({ name: "decisions__record", arguments: { project: proj.key, question: "x", answer: "y", supersedes: 1 } }) as { isError?: boolean }).isError, "a superseded decision can't be superseded again");
      const errOf = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        assert.ok(r.isError, `${name} should fail`);
        return r.content[0].text;
      };
      const del = await call("decisions__delete", { project: proj.key, decision: "D3", confirm: true });
      assert.deepEqual([del.deleted.ref, del.reinstated], ["D3", ["D1"]], "deleting D3 reinstates the D1 it superseded");
      assert.match(del.deleted.deleted.by, /^agent:zz-test:/, "records who deleted it");
      assert.deepEqual((await call("decisions__list", { project: proj.key, item: a.identifier })).decisions.map((d: { ref: string }) => d.ref), ["D1"], "deleted ones are out of default lists");
      assert.ok((await call("decisions__list", { project: proj.key, includeDeleted: true })).decisions.some((d: { ref: string }) => d.ref === "D3"));
      const gone = await call("decisions__get", { project: proj.key, decision: 3 });
      assert.equal(gone.deleted.by, del.deleted.deleted.by, "a deleted decision stays readable, marked");
      assert.equal((await call("decisions__get", { project: proj.key, decision: 1 })).supersededBy, undefined);
      assert.match(await errOf("decisions__delete", { project: proj.key, decision: "D3", confirm: true }), /D3 is already deleted/);
      assert.match(await errOf("decisions__delete", { project: proj.key, decision: 99, confirm: true }), /No decision D99/);
      await errOf("decisions__update", { project: proj.key, decision: "D3", notes: "x" });
      await errOf("decisions__record", { project: proj.key, question: "x", answer: "y", supersedes: "D3" });
      await errOf("decisions__delete", { project: proj.key, decision: "D2" }); // confirm is required
      const dupSrc = (await call("decisions__record", { project: proj.key, question: "ZZ dup", answer: "dup", source: "zz:dup" })).recorded;
      await call("decisions__delete", { project: proj.key, decision: dupSrc.ref, confirm: true });
      const again = await call("decisions__record", { project: proj.key, question: "ZZ dup", answer: "dup", source: "zz:dup" });
      assert.deepEqual([again.alreadyRecorded?.ref, !!again.alreadyRecorded?.deleted], [dupSrc.ref, true], "re-importing a deleted source doesn't resurrect it");
      // docs.delete: a soft delete that keeps the whole history; writing the key again restores it
      assert.equal((await call("docs__put", { project: proj.key, key: "zz-retire", body: "# old\n", expectedVersion: 0 })).written.version, 1);
      assert.deepEqual((await call("docs__delete", { project: proj.key, key: "zz-retire", confirm: true, expectedVersion: 1 })).deleted, { key: "zz-retire", version: 2 });
      assert.ok(!(await call("docs__list", { project: proj.key })).some((d: { key: string }) => d.key === "zz-retire"), "gone from docs.list");
      const hist = await call("docs__history", { project: proj.key, key: "zz-retire" });
      assert.deepEqual([hist[0].change, hist.length], ["deleted", 2], "the delete is a version");
      assert.match(hist[0].updatedBy, /^agent:zz-test:/, "with its actor");
      assert.equal((await call("docs__get", { project: proj.key, key: "zz-retire", version: 1 })).body, "# old\n", "old versions stay readable");
      assert.equal((await call("docs__put", { project: proj.key, key: "zz-retire", body: "# back\n" })).written.version, 3);
      assert.ok((await call("docs__list", { project: proj.key })).some((d: { key: string }) => d.key === "zz-retire"), "rewriting restores it");
      const bad = (await client.callTool({ name: "tasks__update", arguments: { ref: "ZZMCP-9999", title: "x" } })) as { isError?: boolean };
      assert.ok(bad.isError, "unknown identifier is an error, not a silent no-op");
    } finally {
      await client.close();
    }
  });
  await check("apos MCP re-scope: criteria move, exclusions, overlap, decision ranges, cycle goal, assignee, milestone filter, modules.get", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "zz-test", version: "0" });
    await client.connect(new StdioClientTransport({ command: "scripts/apos-mcp.sh", env: { ...process.env, APOS_ACTOR: "zz-test" } as Record<string, string>, stderr: "ignore" }));
    try {
      assert.ok((await client.listTools()).tools.some((t) => t.name === "modules__get"), "exposes modules__get");
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
        return JSON.parse(r.content[0].text);
      };
      const errOf = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        assert.ok(r.isError, `${name} should fail`);
        return r.content[0].text;
      };
      const { created: proj } = await call("projects__create", { name: "ZZ Rescope Test" });
      projectIds.push(proj.id);
      const P = proj.key;

      // modules: the whole description, truncation flag, prepend/append
      const long = `ZZ ${"long description ".repeat(25)}(ADR end)`;
      assert.equal((await call("modules__create", { project: P, name: "ZZ Core", description: long })).created.status, "planned", "planned by default");
      await call("modules__create", { project: P, name: "ZZ Extra" });
      assert.equal((await call("modules__create", { project: P, name: "ZZ Live", status: "active" })).created.status, "active", "created active on request");
      const [listed] = (await call("modules__list", { project: P, status: "all" })).filter((m: { name: string }) => m.name === "ZZ Core");
      assert.equal(listed.descriptionTruncated, true, "modules.list says when it cut a description");
      const [whole] = (await call("modules__list", { project: P, status: "all", fullDescriptions: true })).filter((m: { name: string }) => m.name === "ZZ Core");
      assert.equal(whole.description, long, "modules.list fullDescriptions returns it whole");
      assert.equal(whole.descriptionTruncated, undefined);
      const full = await call("modules__get", { module: "ZZ Core", project: P });
      assert.equal(full.description, long, "modules.get returns the whole description");
      const pre = (await call("modules__update", { module: "ZZ Core", project: P, prependDescription: "DEFERRED. " })).updated;
      assert.equal(pre.description, `DEFERRED. ${long}`);
      assert.equal((await call("modules__update", { module: "ZZ Core", project: P, appendDescription: "\n\nSee D9." })).updated.description, `DEFERRED. ${long}\n\nSee D9.`);
      assert.equal((await call("modules__update", { module: "ZZ Extra", project: P, appendDescription: "Only text." })).updated.description, "Only text.", "appending to an empty description");
      assert.match(await errOf("modules__update", { module: "ZZ Core", project: P, description: "x", appendDescription: "y" }), /not both/);

      // items: assignee on create / update / clear; list filters by it
      const i1 = (await call("tasks__create", { project: P, title: "ZZ r1", feature: "ZZ Core", assignee: " Dana " })).created;
      const i2 = (await call("tasks__create", { project: P, title: "ZZ r2", feature: "ZZ Core" })).created;
      const i3 = (await call("tasks__create", { project: P, title: "ZZ r3", feature: "ZZ Extra" })).created;
      assert.equal(i1.assignee, "Dana", "trimmed");
      assert.equal((await call("tasks__update", { ref: i2.identifier, assignee: "agent:ethos" })).updated.assignee, "agent:ethos");
      assert.deepEqual((await call("tasks__list", { project: P, assignee: "dana" })).map((t: { identifier: string }) => t.identifier), [i1.identifier], "assignee match ignores case");
      assert.deepEqual((await call("tasks__list", { project: P, assignee: "none" })).map((t: { identifier: string }) => t.identifier), [i3.identifier]);
      assert.equal((await call("tasks__update", { ref: i2.identifier, assignee: "" })).updated.assignee, null, "empty string unassigns");
      assert.ok((await call("tasks__get", { ref: i2.identifier })).activity.some((a: { changed?: string; to?: string }) => a.changed === "assignee" && a.to === "agent:ethos"), "assignee changes are in the history");

      // milestones: two stages that share an item, then the re-scope moves
      await call("milestones__create", { project: P, name: "ZZ MVP", description: "first cut" });
      await call("milestones__create", { project: P, name: "ZZ Next" });
      await call("milestones__addContent", { milestone: "ZZ MVP", project: P, modules: ["ZZ Core"] });
      await call("milestones__addContent", { milestone: "ZZ Next", project: P, items: [i1.identifier, i3.identifier] });
      const mvp = await call("milestones__get", { milestone: "ZZ MVP", project: P });
      assert.deepEqual(mvp.sharedWith, [{ milestone: "ZZ Next", items: [i1.identifier] }], "overlap between unrelated milestones is reported");
      assert.deepEqual(
        (await call("tasks__list", { project: P, milestone: "ZZ MVP" })).map((t: { identifier: string }) => t.identifier).sort(),
        [i1.identifier, i2.identifier].sort(),
        "tasks.list filters by milestone scope",
      );
      const withMs = await call("tasks__list", { project: P, withMilestones: true });
      assert.deepEqual(withMs.find((t: { identifier: string }) => t.identifier === i1.identifier).milestones, ["ZZ MVP", "ZZ Next"]);
      assert.deepEqual(withMs.find((t: { identifier: string }) => t.identifier === i3.identifier).milestones, ["ZZ Next"]);
      assert.match(await errOf("tasks__list", { project: P, milestone: "ZZ Nope" }), /milestone/i);

      // exclusions: exclude on one side clears the overlap; a plain add flips it back
      await call("milestones__addContent", { milestone: "ZZ MVP", project: P, items: [i1.identifier], exclude: true });
      assert.equal((await call("milestones__get", { milestone: "ZZ MVP", project: P })).sharedWith, undefined, "excluding on one side resolves it");
      const back = await call("milestones__addContent", { milestone: "ZZ MVP", project: P, items: [i1.identifier] });
      assert.deepEqual(back.included, [i1.identifier], "a plain add flips an exclusion back into scope");
      await call("milestones__addContent", { milestone: "ZZ MVP", project: P, items: [i2.identifier], exclude: true });
      const rm = await call("milestones__removeContent", { milestone: "ZZ MVP", project: P, modules: ["ZZ Core"] });
      assert.deepEqual(rm.droppedExclusions, [i2.identifier], "removing the module drops the exclusion that only it needed");
      const after = await call("milestones__get", { milestone: "ZZ MVP", project: P });
      assert.deepEqual([after.excluded, after.progress.total], [[], 1], "only the re-added single item is left");

      // criteria: reword in place, move to another milestone keeping the checked state
      await call("milestones__criteria", { milestone: "ZZ MVP", project: P, add: ["Login works", "Audit log", "Exports"] });
      await call("milestones__criteria", { milestone: "ZZ MVP", project: P, check: ["2"], edit: [{ criterion: "1", text: "Login + SSO works" }] });
      const mv = await call("milestones__criteria", { milestone: "ZZ MVP", project: P, move: ["2", "Exports"], to: "ZZ Next" });
      assert.deepEqual(mv.criteria, ["1. [ ] Login + SSO works"]);
      assert.deepEqual(mv.movedTo, { milestone: "ZZ Next", criteria: ["1. [x] Audit log", "2. [ ] Exports"] });
      assert.match(await errOf("milestones__criteria", { milestone: "ZZ MVP", project: P, move: ["1"] }), /needs `to`/);
      assert.match(await errOf("milestones__criteria", { milestone: "ZZ MVP", project: P, move: ["1"], to: "ZZ MVP" }), /this milestone/);
      await call("milestones__update", { milestone: "ZZ MVP", project: P, description: "MVP-1: the re-scoped cut" });
      assert.equal((await call("milestones__get", { milestone: "ZZ MVP", project: P })).goal, "MVP-1: the re-scoped cut");

      // a module created active takes items moved in with tasks.update, and goes whole into a capability
      const i4 = (await call("tasks__create", { project: P, title: "ZZ r4" })).created;
      await call("tasks__update", { ref: i4.identifier, feature: "ZZ Live" });
      assert.equal((await call("modules__get", { module: "ZZ Live", project: P })).items, 1, "moved in");
      await call("milestones__addContent", { milestone: "ZZ Next", project: P, capability: "Estate", modules: ["ZZ Live"] });
      const next = await call("milestones__get", { milestone: "ZZ Next", project: P });
      const estate = next.capabilities.find((c: { name: string }) => c.name === "Estate");
      assert.deepEqual([estate.content, estate.progress], [['module "ZZ Live"'], "0/1"], "the whole module counts, no item excluded");
      assert.deepEqual(next.excluded, []);

      // decisions: a number range, paging, brief rows
      for (let n = 1; n <= 6; n++) await call("decisions__record", { project: P, question: `ZZ q${n}`, answer: `a${n}`, notes: "long notes" });
      const range = await call("decisions__list", { project: P, from: "D2", to: 5, limit: 2, brief: true });
      assert.equal(range.total, 4, "D2–D5 inclusive");
      assert.equal(range.decisions.length, 2, "paged");
      assert.deepEqual(Object.keys(range.decisions[0]).sort(), ["answer", "decidedAt", "question", "ref"], "brief rows carry only the essentials");
      const page2 = await call("decisions__list", { project: P, from: 2, to: 5, limit: 2, offset: 2, brief: true });
      assert.deepEqual(
        [...range.decisions, ...page2.decisions].map((d: { ref: string }) => d.ref).sort(),
        ["D2", "D3", "D4", "D5"],
        "the two pages cover the range exactly",
      );

      // cycles: a goal on create, update, list and get; a rename keeps it; empty clears it
      const now = Date.now();
      const sunday = new Date(now).setUTCHours(0, 0, 0, 0) - new Date(now).getUTCDay() * DAY;
      const span = { startsAt: new Date(sunday).toISOString(), endsAt: new Date(sunday + 6 * DAY).toISOString() };
      const cyc = (await call("cycles__create", { project: P, name: "ZZ goal sprint", goal: "Ship the MVP cut", ...span })).created;
      assert.equal(cyc.goal, "Ship the MVP cut");
      await call("cycles__update", { cycle: "ZZ goal sprint", project: P, name: "ZZ goal sprint 2" });
      assert.equal((await call("cycles__get", { cycle: "ZZ goal sprint 2", project: P })).goal, "Ship the MVP cut", "a rename keeps the goal");
      await call("cycles__update", { cycle: "ZZ goal sprint 2", project: P, goal: "Close the gaps" });
      assert.equal((await call("cycles__list", { project: P })).find((c: { name: string }) => c.name === "ZZ goal sprint 2").goal, "Close the gaps");
      await call("cycles__update", { cycle: "ZZ goal sprint 2", project: P, goal: "" });
      assert.equal((await call("cycles__get", { cycle: "ZZ goal sprint 2", project: P })).goal ?? null, null, "an empty goal clears it");
    } finally {
      await client.close();
    }
  });
  await check("apos CLI: comment, docs with conflicts, decisions — one line out, exit codes", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "zz-cli-")); // a caller's own cwd: file args resolve there
    const cli = (args: string[], stdin?: string) => {
      const r = spawnSync(join(process.cwd(), "scripts/apos.sh"), args, { cwd: dir, input: stdin, encoding: "utf8", env: { ...process.env, APOS_ACTOR: "zz-cli" } });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const p = await zzProject("ZZ CLI Test", "ZZCLI");
    const item = await createWorkItem(db, { title: "ZZ cli item", projectRef: `projects:${p.id}` }, "user");

    const note = "## Finding\n\n  indented `code` — ünïcode\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const c = cli(["tasks.comment", `ref=${item.identifier}`, "body=@-"], `${note}\n\n`);
    assert.deepEqual([c.code, c.err], [0, ""]);
    assert.match(c.out, /^[0-9a-f-]{36}\n$/, "stdout is the comment id alone");
    const [row] = await db.select().from(taskActivity).where(eq(taskActivity.id, c.out.trim()));
    assert.equal(row.body, note, "the body lands as sent (edges trimmed, like every comment)");
    assert.match(row.actor ?? "", /^agent:zz-cli:apos-cli#[0-9a-f]{6}$/, "credited like an MCP session");

    const doc = "# Resume\n\n## Next steps\n\nold\n\n## Notes\n\nkeep me\n";
    writeFileSync(join(dir, "doc.md"), doc);
    assert.deepEqual(cli(["docs.put", "project=ZZCLI", "key=zz-resume", "body=@doc.md", "expectedVersion=0"]).out, "1\n", "a new doc → version 1");
    const patched = cli(["docs.patchSection", "project=ZZ CLI Test", "key=zz-resume", "heading=Next steps", "body=@-", "expectedVersion=1"], "\nnew\n\n");
    assert.deepEqual([patched.code, patched.out], [0, "2\n"]);
    const stale = cli(["docs.patchSection", "project=ZZCLI", "key=zz-resume", "heading=Notes", "body=x", "expectedVersion=1"]);
    assert.equal(stale.code, 3, "a stale expectedVersion is a conflict");
    assert.deepEqual([stale.out, stale.err.split("\n").length], ["", 2], "nothing on stdout, one line on stderr");
    assert.match(stale.err, /^conflict: The doc is at version 2, not 1/);
    const got = JSON.parse(cli(["docs.get", "project=ZZCLI", "key=zz-resume"]).out);
    assert.deepEqual([got.version, got.body], [2, "# Resume\n\n## Next steps\n\nnew\n\n## Notes\n\nkeep me\n"], "the conflict wrote nothing");
    assert.equal(cli(["docs.put", "project=ZZCLI", "key=zz-resume", "body=@doc.md", "expectedVersion=0"]).code, 3, "0 on an existing doc conflicts too");

    const d = cli(["decisions.record", "project=ZZCLI", "question=ZZ ship it?", "answer=Yes", `items:=["${item.identifier}"]`, "source=zz-cli:1"]);
    assert.deepEqual([d.code, d.out], [0, "D1\n"]);
    assert.equal(cli(["decisions.record", "project=ZZCLI", "question=dup", "answer=dup", "source=zz-cli:1"]).out, "D1\n", "same source → the existing decision");
    assert.equal(JSON.parse(cli(["decisions.delete", "project=ZZCLI", "decision=D1", "confirm=true"]).out).deleted.ref, "D1", "confirm=true is the literal true");
    assert.equal(cli(["docs.delete", "project=ZZCLI", "key=zz-resume", "confirm=true"]).code, 0);
    assert.equal(cli(["docs.delete", "project=ZZCLI", "key=zz-resume", "confirm=false"]).code, 2, "anything but true is a usage error");

    const bad = cli(["docs.put", "project=ZZCLI", "key=zz-resume", "body=x", "expectedVersion=two"]);
    assert.deepEqual([bad.code, bad.out], [2, ""], "a value that doesn't fit the field is a usage error");
    assert.match(bad.err, /^usage: expectedVersion takes a number/);
    assert.equal(cli(["tasks.comment", "ref=ZZCLI-9999", "body=x"]).code, 1, "an unknown item is an error");
    assert.equal(cli(["memory.update"]).code, 2, "only the work-tracker surface");
  });
} finally {
  // teardown
  const zzTasks = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.projectRef, projectIds.map((id) => `projects:${id}`)));
  for (const t of zzTasks) await deleteWorkItem(db, t.id);
  if (projectIds.length) {
    await db.delete(features).where(inArray(features.projectId, projectIds));
    await db.delete(cycles).where(inArray(cycles.projectId, projectIds));
    await db.delete(projectDecisions).where(inArray(projectDecisions.projectId, projectIds));
    const zzMilestones = db.select({ id: milestones.id }).from(milestones).where(inArray(milestones.projectId, projectIds));
    await db.delete(milestoneContent).where(inArray(milestoneContent.milestoneId, zzMilestones));
    await db.delete(milestoneCapabilities).where(inArray(milestoneCapabilities.milestoneId, zzMilestones));
    await db.delete(milestones).where(inArray(milestones.projectId, projectIds));
    await db.execute(sql`delete from project_doc_versions where doc_id in (select id from project_docs where project_id in ${projectIds})`);
    await db.execute(sql`delete from project_docs where project_id in ${projectIds}`);
    await db.execute(sql`delete from work_counters where scope in ${[...projectIds, ...projectIds.map((id) => `decisions:${id}`)]}`);
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  // The MCP test's approval-tier calls park an approval and ring the bell.
  await db.execute(sql`delete from approvals where agent_name like 'MCP zz-test%'`);
  await db.execute(sql`delete from notifications where source like 'agent:MCP zz-test%'`);
  if (wbIds.length) await db.delete(workbenchTasks).where(inArray(workbenchTasks.id, wbIds));
  const left = await db.select({ id: tasks.id }).from(tasks).where(like(tasks.title, "ZZ %"));
  const orphanLinks = await db.execute(sql`select count(*)::int n from task_links l left join tasks t on t.id = l.task_id where t.id is null`);
  console.log(`teardown: ${left.length} ZZ items left, ${(orphanLinks[0] as { n: number }).n} orphan links`);
  void taskLinks;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
