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
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { features, projects } from "@/modules/projects/schema";
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
import { applyCommits, commitUrl, scanMessage } from "@/modules/tasks/commits";
import { burndown, createCycle, cycleStatus, deleteCycle, listCycles, rollOverCycle } from "@/modules/tasks/cycles";
import { syncFromWorkbench } from "@/modules/tasks/delegate";
import { importPlane, previewPlane, Progress } from "@/modules/tasks/plane/import";
import { apiBaseFrom } from "@/modules/tasks/plane/client";
import { htmlToText, mapModuleStatus, mapState } from "@/modules/tasks/plane/map";
import { cycles, taskActivity, taskLinks, tasks } from "@/modules/tasks/schema";
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
        { sha: sha2, author: "zz", subject: `fix: thing (fixes ${b.identifier})`, body: "" },
        { sha: sha1, author: "zz", subject: `wip on ${b.identifier}`, body: "" },
      ],
      { repoUrl: "https://github.com/zz/zz.git", allowClose: true },
    );
    assert.deepEqual(r, { linked: 2, closed: 1 });
    const d = await getWorkItem(db, b.id);
    assert.equal(d!.item.status, "done");
    assert.equal(d!.links.filter((l) => l.kind === "commit").length, 2);
    assert.ok(d!.activity.some((x) => x.actor === "system:commit" && x.kind === "comment"));
    await updateWorkItem(db, b.id, { status: "todo" }, "user");
    const again = await applyCommits(db, [{ sha: sha2, author: "zz", subject: `fixes ${b.identifier}`, body: "" }], {
      repoUrl: null,
      allowClose: true,
    });
    assert.deepEqual(again, { linked: 0, closed: 0 });
  });

  await check("baseline scan links but never closes", async () => {
    const c = await createWorkItem(db, { title: "ZZ c", projectRef: ref }, "user");
    const r = await applyCommits(db, [{ sha: "3".repeat(40), author: "zz", subject: `closes ${c.identifier}`, body: "" }], {
      repoUrl: null,
      allowClose: false,
    });
    assert.deepEqual(r, { linked: 1, closed: 0 });
  });

  await check("cycles: summary, roll-over, delete un-plans", async () => {
    const now = Date.now();
    const done = await createCycle(db, { name: "ZZ c1", startsAt: new Date(now - 20 * DAY), endsAt: new Date(now - 7 * DAY), projectId: p.id });
    const cur = await createCycle(db, { name: "ZZ c2", startsAt: new Date(now - 6 * DAY), endsAt: new Date(now + 7 * DAY), projectId: p.id });
    await updateWorkItem(db, b.id, { cycleId: done.id }, "user");
    await updateWorkItem(db, a.id, { cycleId: done.id }, "user");
    const mine = (await listCycles(db, { projectId: p.id })).find((c) => c.id === done.id)!;
    assert.equal(mine.status, "completed");
    assert.equal(mine.total, 2);
    assert.equal(mine.done, 1);
    assert.equal(await rollOverCycle(db, done.id, cur.id), 1);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].cycleId, cur.id);
    await deleteCycle(db, cur.id);
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, b.id)))[0].cycleId, null);
    await deleteCycle(db, done.id);
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
} finally {
  // teardown
  const zzTasks = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.projectRef, projectIds.map((id) => `projects:${id}`)));
  for (const t of zzTasks) await deleteWorkItem(db, t.id);
  if (projectIds.length) {
    await db.delete(features).where(inArray(features.projectId, projectIds));
    await db.delete(cycles).where(inArray(cycles.projectId, projectIds));
    await db.execute(sql`delete from work_counters where scope in ${projectIds}`);
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  if (wbIds.length) await db.delete(workbenchTasks).where(inArray(workbenchTasks.id, wbIds));
  const left = await db.select({ id: tasks.id }).from(tasks).where(like(tasks.title, "ZZ %"));
  const orphanLinks = await db.execute(sql`select count(*)::int n from task_links l left join tasks t on t.id = l.task_id where t.id is null`);
  console.log(`teardown: ${left.length} ZZ items left, ${(orphanLinks[0] as { n: number }).n} orphan links`);
  void taskLinks;
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
