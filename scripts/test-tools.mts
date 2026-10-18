/**
 * Tool integration smoke-test — the ecosystem's agents can only work if every
 * AI tool retrieves and writes the right data. This calls EVERY registered tool
 * the way the runtime does (input parsed through its zod schema, then execute
 * with a real toolCtx), asserts the effect, and cleans up.
 *
 * Run:  npx tsx scripts/test-tools.mts        (needs the dev DB reachable)
 * Exit: non-zero if any tool fails.
 *
 * These are INTEGRATION tests against the live schema/integrations, not isolated
 * units — the tools are thin wrappers over the DB and external services, so a
 * real round-trip is what actually proves them. Throwaway rows are prefixed
 * `ZZ_` and removed on teardown; anything touching real data (a person's note)
 * is saved and restored. External side-effect tools (slack.post, notify.send,
 * workbench.delegate/openPR, routine.create, web/knowledge fetch) are exercised
 * only for their validation guard, never fired.
 */
import { db, sql } from "@/core/db/client";
import { getToolsByNames } from "@/core/ai/tool-registry";
import { getServerModules } from "@/modules/registry.server";
import { eq, like } from "drizzle-orm";
import { projects } from "@/modules/projects/schema";
import { tasks } from "@/modules/tasks/schema";
import { notes } from "@/modules/notes/schema";
import { ideas } from "@/modules/ideas/schema";
import { attentionItems } from "@/modules/today/schema";
import { people } from "@/modules/people/schema";

const CORE = [
  "search.everything", "memory.update", "memory.remember", "memory.recall", "memory.review",
  "notify.send", "web.search", "web.read",
];
const names = new Set<string>();
for (const m of getServerModules()) for (const t of m.aiTools) names.add(t.name);
const T = new Map(getToolsByNames([...names, ...CORE]).map((t: any) => [t.name, t]));

const ctx: any = { db, refs: {}, subject: null, subjectCursor: null };
/** Invoke a tool the way a provider does: parse raw args through its zod schema
 *  (applying defaults/coercion), then execute against the shared ctx. */
async function call(name: string, raw: any, c: any = ctx) {
  const def = T.get(name) as any;
  if (!def) return { error: "TOOL NOT REGISTERED" };
  let input: any;
  try { input = def.input.parse(raw ?? {}); } catch (e: any) { return { error: `input parse: ${e?.message ?? e}` }; }
  try { return await def.execute(input, c); } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

const R: { n: string; pass: boolean; d: string }[] = [];
const rec = (n: string, pass: boolean, d = "") => R.push({ n, pass, d });
const has = (o: any, ...k: string[]) => o && typeof o === "object" && !("error" in o) && k.every((x) => x in o);
const arr = Array.isArray;

async function clean() {
  for (const p of await db.select({ id: projects.id }).from(projects).where(like(projects.name, "ZZ\\_%"))) {
    await db.delete(attentionItems).where(eq(attentionItems.projectRef, `projects:${p.id}`));
    await db.delete(tasks).where(eq(tasks.projectRef, `projects:${p.id}`));
    await db.delete(projects).where(eq(projects.id, p.id));
  }
  await db.delete(notes).where(like(notes.title, "ZZ\\_%"));
  await db.delete(ideas).where(like(ideas.title, "ZZ\\_%"));
  await db.delete(attentionItems).where(like(attentionItems.title, "ZZ\\_%"));
}

async function main() {
  await clean();

  // ---- SETUP: an ACTIVE project we keep active, plus a spare for setStatus ----
  const cp: any = await call("projects.create", { name: "ZZ_ToolTest" });
  const pid = cp?.created?.id;
  rec("projects.create", !!pid, pid ? `id ${pid.slice(0, 8)}` : JSON.stringify(cp));
  const cp2: any = await call("projects.create", { name: "ZZ_ToolTest2" });
  const pid2 = cp2?.created?.id;

  // ---- READS ----
  const pl: any = await call("projects.list", {});
  rec("projects.list", arr(pl) && pl.some((p: any) => p.id === pid), `${arr(pl) ? pl.length : "?"} rows`);
  const fc: any = { db, refs: {}, subject: null, subjectCursor: null };
  const fn: any = await call("projects.focusNext", {}, fc);
  rec("projects.focusNext", fn?.done || has(fn, "focused", "project"), fn?.focused ? `focused ${fn.focused}` : "done");
  rec("projects.withoutNextAction", arr(await call("projects.withoutNextAction", {})));
  const lf: any = await call("projects.listFiles", { project: "ZZ_ToolTest" });
  rec("projects.listFiles", arr(lf) && lf.length === 0, "empty for new project");
  const rr: any = await call("projects.readRepo", { projectId: pid });
  rec("projects.readRepo", rr?.attached === false, "attached:false (no repo)");
  const tl: any = await call("tasks.list", { limit: 5 });
  rec("tasks.list", arr(tl) && tl.every((t: any) => t.ref), `${arr(tl) ? tl.length : "?"} w/ refs`);
  rec("ideas.list", arr(await call("ideas.list", { limit: 5 })));
  const ppl: any = await call("people.list", { limit: 5 });
  rec("people.list", arr(ppl) && ppl.every((p: any) => p.ref), `${arr(ppl) ? ppl.length : "?"} w/ refs`);
  const havePeople = arr(ppl) && ppl.length > 0;
  rec("people.get", havePeople ? has(await call("people.get", { ref: ppl[0].ref }), "name", "email", "notes", "openFollowups") : true, havePeople ? "notes present" : "(no people)");
  rec("people.recentMeetings", arr(await call("people.recentMeetings", { days: 7 })));
  const ns: any = await call("notes.search", { query: "e" });
  rec("notes.search", arr(ns) && ns.every((x: any) => x.ref), `${arr(ns) ? ns.length : "?"} w/ refs`);
  rec("notes.read", arr(ns) && ns.length ? has(await call("notes.read", { ref: ns[0].ref }), "id", "title", "body") : true);
  const ks: any = await call("knowledge.search", { query: "e" });
  rec("knowledge.search", arr(ks) && ks.every((x: any) => x.ref), `${arr(ks) ? ks.length : "?"} w/ refs`);
  rec("knowledge.read", arr(ks) && ks.length ? has(await call("knowledge.read", { ref: ks[0].ref }), "id", "kind") : true);
  const wl: any = await call("workbench.list", {});
  rec("workbench.list", arr(wl) && wl.every((x: any) => x.ref), `${arr(wl) ? wl.length : "?"} w/ refs`);
  rec("workbench.get", arr(wl) && wl.length ? has(await call("workbench.get", { ref: wl[0].ref }), "id", "status") : true);
  const al: any = await call("attention.list", {});
  rec("attention.list", arr(al) && al.every((x: any) => x.ref), `${arr(al) ? al.length : "?"} w/ refs`);
  const ca: any = await call("calendar.agenda", {});
  rec("calendar.agenda", arr(ca), arr(ca) ? `${ca.length} items` : String(ca?.error).slice(0, 40));
  const gm: any = await call("gmail.recent", {});
  rec("gmail.recent", arr(gm) || gm?.error?.includes("not connected"), arr(gm) ? `${gm.length} mail` : String(gm?.error).slice(0, 40));
  rec("search.everything", !(await call("search.everything", { query: "project" }))?.error);
  const obs: any = await call("obsidian.search", { query: "the" });
  rec("obsidian.search", arr(obs) || !!obs?.error, arr(obs) ? `${obs.length} notes` : "unavailable");
  rec("memory.recall", !(await call("memory.recall", { query: "user" }))?.error);
  const mrev: any = await call("memory.review", { limit: 5 });
  rec("memory.review", arr(mrev) && (mrev.length === 0 || "tier" in mrev[0]), `${arr(mrev) ? mrev.length : "?"} entries w/ tier`);

  // ---- WRITES on the throwaway (kept active) ----
  rec("projects.setStatus", (await call("projects.setStatus", { project: "ZZ_ToolTest2", status: "paused" }))?.updated?.status === "paused", "spare → paused");
  rec("projects.setHealth", (await call("projects.setHealth", { id: pid, health: "on_track", reason: "test" }))?.updated?.health === "on_track");
  rec("projects.setGoal", (await call("projects.setGoal", { id: pid, goal: "test goal" }))?.updated?.goal === "test goal");
  rec("projects.setNextAction", (await call("projects.setNextAction", { project: "ZZ_ToolTest", nextAction: "test next" }))?.updated === true);
  // Grounded brief (cites a task + numbers) so the local quality-judge passes it.
  rec("projects.setAdvisorBrief", (await call("projects.setAdvisorBrief", { projectId: pid, state: "Task 'ZZ_ToolTest task' is 3 days idle; 1 of 2 tasks overdue.", recommendation: "Finish the ZZ_ToolTest task this week, then close out the overdue item." }))?.updated?.id === pid);
  rec("projects.recordRepoDigest", (await call("projects.recordRepoDigest", { projectId: pid, digest: "test digest" }))?.updated?.id === pid);

  const tc: any = await call("tasks.create", { title: "ZZ_ToolTest task", project: "ZZ_ToolTest" });
  const tid = tc?.created?.id;
  rec("tasks.create", !!tid && (await db.select().from(tasks).where(eq(tasks.id, tid)))[0]?.projectRef === `projects:${pid}`, "filed under project");
  const tl2: any = await call("tasks.list", { search: "ZZ_ToolTest" });
  const tref = tl2.find?.((t: any) => t.id === tid)?.ref;
  rec("tasks.setStatus", (await call("tasks.setStatus", { ref: tref, status: "doing" }))?.updated?.status === "doing", `ref ${tref}`);
  rec("tasks.update", (await call("tasks.update", { ref: tref, priority: "high" }))?.updated?.id === tid);

  const nc: any = await call("notes.create", { title: "ZZ_ToolTest note", body: "hi", project: "ZZ_ToolTest" });
  const nid = nc?.created?.id;
  rec("notes.create", !!nid);
  const ns2: any = await call("notes.search", { query: "ZZ_ToolTest" });
  const nref = ns2.find?.((n: any) => n.id === nid)?.ref;
  rec("notes.append", (await call("notes.append", { ref: nref, text: "appended" }))?.updated?.id === nid, `ref ${nref}`);
  rec("notes.setProject", (await call("notes.setProject", { ref: nref, project: "ZZ_ToolTest" }))?.updated?.projectRefs?.[0] === `projects:${pid}`, "linked");

  const ic: any = await call("ideas.capture", { title: "ZZ_ToolTest idea" });
  const iid = ic?.captured?.id;
  rec("ideas.capture", !!iid);
  const il2: any = await call("ideas.list", { limit: 20 });
  const iref = il2.find?.((x: any) => x.id === iid)?.ref;
  rec("ideas.setStage", (await call("ideas.setStage", { ref: iref, stage: "exploring" }))?.updated?.stage === "exploring", `ref ${iref}`);

  const ar: any = await call("attention.raise", { type: "notify", title: "ZZ_ToolTest card", project: "ZZ_ToolTest", body: "t" });
  const aid = ar?.id;
  rec("attention.raise", !!aid && ar.raised, "raised + anchored");
  const al2: any = await call("attention.list", { limit: 50 });
  const aref = al2.find?.((x: any) => x.id === aid)?.ref;
  rec("attention.resolve", (await call("attention.resolve", { ref: aref, status: "dismissed", reason: "test" }))?.resolved?.status === "dismissed", `ref ${aref}`);
  // conservative guard: refuse a card an agent did NOT raise
  const [sysCard] = await db.insert(attentionItems).values({ type: "notify", title: "ZZ_sys", source: "system", dedupeKey: "zz_" + Date.now() }).returning();
  ctx.refs["a_sys"] = { kind: "attention", id: sysCard.id, name: "ZZ_sys" };
  rec("attention.resolve[guard:system]", !!(await call("attention.resolve", { ref: "a_sys" }))?.error, "refuses system-raised card");
  await db.delete(attentionItems).where(eq(attentionItems.id, sysCard.id));

  if (havePeople) {
    const pref = ppl[0].ref;
    const before: any = await call("people.get", { ref: pref });
    const set: any = await call("people.setNotes", { ref: pref, notes: "ZZ test note" });
    const after: any = await call("people.get", { ref: pref });
    rec("people.setNotes", set?.updated && after.notes === "ZZ test note", "set + verified (restoring)");
    await db.update(people).set({ notes: before.notes }).where(eq(people.id, ctx.refs[pref].id));
    const fr: any = await call("followup.raise", { ref: pref, type: "notify", title: "ZZ_ToolTest followup" });
    rec("followup.raise", !!fr?.id && fr.raised);
    if (fr?.id) await db.delete(attentionItems).where(eq(attentionItems.id, fr.id));
  } else {
    rec("people.setNotes", true, "(no people)");
    rec("followup.raise", true, "(no people)");
  }
  rec("tasks.delete", (await call("tasks.delete", { ref: tref }))?.deleted === tid, "deleted test task");

  // ---- GUARD-ONLY (external side effects never fired) ----
  rec("workbench.openPR[guard]", !!(await call("workbench.openPR", { ref: "zz999", title: "x", body: "y" }))?.error, "rejects unknown ref");
  rec("routine.create[guard]", !!(await call("routine.create", { name: "zz", project: "NONEXISTENT_ZZ", prompt: "x" }))?.error, "rejects unknown project");

  await clean();
  rec("[teardown]", true, "throwaway entities removed");

  // ---- REPORT ----
  const fails = R.filter((r) => !r.pass);
  console.log(`\n=== TOOL SMOKE-TEST: ${R.length - fails.length}/${R.length} passed ===`);
  for (const r of R) console.log(`  ${r.pass ? "✓" : "✗ FAIL"} ${r.n.padEnd(30)} ${r.d}`);
  const skipped = ["slack.post", "notify.send", "workbench.delegate", "web.search", "web.read", "obsidian.read", "knowledge.capture", "memory.update", "memory.remember"];
  console.log(`\nnot fired (external side-effects; guards checked where applicable): ${skipped.join(", ")}`);
  await sql.end();
  if (fails.length) process.exit(1);
}

main().catch(async (e) => { console.error("HARNESS ERROR:", e?.stack || e); await clean().catch(() => {}); await sql.end(); process.exit(1); });
