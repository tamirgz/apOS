/**
 * apOS agent worker — runs on the host (needs Claude CLI credentials + Ollama).
 * Responsibilities: cron-schedule agents, execute runs, orphan recovery,
 * module background jobs. Postgres LISTEN/NOTIFY is the message bus.
 *
 * Start with: pnpm worker
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { Cron } from "croner";
import { and, eq, lt, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { db, sql } from "@/core/db/client";
import { agentRuns, agents, type Agent } from "@/core/db/schema/agents";
import { notifications } from "@/core/db/schema/notifications";
import { getSetting, SETTING_KEYS } from "@/core/app-settings";
import { reportJobOutcome } from "@/core/alerts";
import { serverModules } from "@/modules/registry.server";
import { fireRoutine } from "@/modules/workbench/routines";
import { routines } from "@/modules/workbench/schema";
import { runFlow } from "@/modules/flows/engine";
import { flows } from "@/modules/flows/schema";
import { enqueueRun, executeApproval, executeRun } from "./executor";
import { hasFreshBackup, runBackup } from "./backup";

async function deliverToSlack(notificationId: string) {
  const webhook = await getSetting(SETTING_KEYS.slackWebhookUrl);
  if (!webhook) return;
  const [n] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, notificationId));
  if (!n) return;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `*apOS · ${n.title}*${n.body ? `\n${n.body}` : ""}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`slack webhook → ${res.status}`);
  log(`notification ${notificationId} delivered to Slack`);
}

const ADVISORY_LOCK_KEY = 0x41494f53; // "AIOS"
const ORPHAN_AFTER_MS = 60 * 1000;

const url =
  process.env.DATABASE_URL ?? "postgres://aios:aios@localhost:5544/aios";

const log = (msg: string) =>
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);

/** Run a module job and make a persistent failure NOISY (transition-based bell +
 *  Slack + self-closing card via reportJobOutcome). Still logs like before. */
async function runJob(channel: string, run: () => Promise<void>) {
  try {
    await run();
    await reportJobOutcome(channel, true);
  } catch (e) {
    log(`job ${channel} failed: ${e}`);
    await reportJobOutcome(channel, false, e);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crons = new Map<string, Cron>();

async function syncSchedules() {
  const rows = await db.select().from(agents).where(eq(agents.enabled, true));
  const wanted = new Map(
    rows.filter((a) => a.schedule).map((a) => [a.id, a as Agent]),
  );

  for (const [id, cron] of crons) {
    const agent = wanted.get(id);
    if (!agent || agent.schedule !== cron.getPattern()) {
      cron.stop();
      crons.delete(id);
      log(`unscheduled agent ${id}`);
    }
  }

  for (const [id, agent] of wanted) {
    if (crons.has(id)) continue;
    try {
      const cron = new Cron(agent.schedule!, { protect: true }, async () => {
        // enqueueRun only returns null for "a live run exists"; a real DB error
        // (connection blip mid-cron) is logged distinctly — the 5-min safety-net
        // pickUpQueuedRuns/next fire covers the missed period.
        let runId: string | null = null;
        try {
          runId = await enqueueRun(id, "cron");
        } catch (e) {
          log(`cron enqueue failed (${agent.name}): ${e}`);
          return;
        }
        if (runId) {
          log(`cron fired → run ${runId} (${agent.name})`);
          await executeRun(runId);
        } else {
          log(`cron fired but a live run exists — skipped (${agent.name})`);
        }
      });
      crons.set(id, cron);
      log(`scheduled "${agent.name}" [${agent.schedule}]`);
    } catch (e) {
      log(`invalid cron for "${agent.name}": ${e}`);
    }
  }
}

const routineCrons = new Map<string, Cron>();

/** Schedule-triggered routines get a cron each, exactly like agents. */
async function syncRoutineCrons() {
  const rows = await db.select().from(routines).where(eq(routines.enabled, "true"));
  const wanted = new Map(
    rows
      .filter((r) => (r.triggerKind === "schedule" || r.triggerKind === "both") && r.schedule)
      .map((r) => [r.id, r]),
  );

  for (const [id, cron] of routineCrons) {
    const r = wanted.get(id);
    if (!r || r.schedule !== cron.getPattern()) {
      cron.stop();
      routineCrons.delete(id);
      log(`unscheduled routine ${id}`);
    }
  }

  for (const [id, r] of wanted) {
    if (routineCrons.has(id)) continue;
    try {
      const cron = new Cron(r.schedule!, { protect: true }, async () => {
        log(`routine cron fired → ${r.name}`);
        await fireRoutine(id).catch((e) => log(`routine ${id} failed: ${e}`));
      });
      routineCrons.set(id, cron);
      log(`scheduled routine "${r.name}" [${r.schedule}]`);
    } catch (e) {
      log(`invalid cron for routine "${r.name}": ${e}`);
    }
  }
}

const flowCrons = new Map<string, Cron>();

/** Schedule-triggered flows get a cron each — the flow's trigger jsonb carries
 *  { kind: "schedule", cron }. Fires runFlow(id, "schedule") in this worker. */
async function syncFlowCrons() {
  const rows = await db.select().from(flows).where(eq(flows.enabled, true));
  const wanted = new Map(
    rows
      .filter((f) => f.trigger?.kind === "schedule" && f.trigger.cron)
      .map((f) => [f.id, f]),
  );

  for (const [id, cron] of flowCrons) {
    const f = wanted.get(id);
    const pattern = f?.trigger?.kind === "schedule" ? f.trigger.cron : undefined;
    if (!f || pattern !== cron.getPattern()) {
      cron.stop();
      flowCrons.delete(id);
      log(`unscheduled flow ${id}`);
    }
  }

  for (const [id, f] of wanted) {
    if (flowCrons.has(id)) continue;
    const pattern = f.trigger?.kind === "schedule" ? f.trigger.cron : undefined;
    if (!pattern) continue;
    try {
      const cron = new Cron(pattern, { protect: true }, async () => {
        log(`flow cron fired → ${f.name}`);
        await runFlow(id, "schedule").catch((e) => log(`flow ${id} failed: ${e}`));
      });
      flowCrons.set(id, cron);
      log(`scheduled flow "${f.name}" [${pattern}]`);
    } catch (e) {
      log(`invalid cron for flow "${f.name}": ${e}`);
    }
  }
}

async function sweepOrphans() {
  const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS);
  // coalesce: queued runs never get a heartbeat — judge them by created_at,
  // otherwise a run whose NOTIFY was missed is invisible to the sweep.
  const orphaned = await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: "orphaned (worker restarted or crashed mid-run)",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(agentRuns.status, "running"),
        dsql`coalesce(${agentRuns.heartbeatAt}, ${agentRuns.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: agentRuns.id });
  if (orphaned.length) log(`orphan sweep: failed ${orphaned.length} run(s)`);
}

/** Execute queued runs whose NOTIFY was missed (e.g. worker restart window). */
async function pickUpQueuedRuns() {
  const stale = new Date(Date.now() - 30_000);
  const queued = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.status, "queued"), lt(agentRuns.createdAt, stale)),
    );
  for (const q of queued) {
    log(`picking up stale queued run ${q.id}`);
    executeRun(q.id).catch((e) => log(`run ${q.id} failed: ${e}`));
  }
}

/**
 * Flows execute in-process in THIS worker (single runner via the advisory
 * lock), so any flow run still queued/running at boot died with the previous
 * process — without this it sat in "running" forever. Paused runs are left
 * alone: a human gate legitimately survives restarts and resumes on decision.
 */
async function sweepOrphanedFlowRuns() {
  const orphaned = await db.execute(dsql`
    update flow_runs
       set status = 'failed',
           error = 'orphaned (worker restarted or crashed mid-flow)',
           finished_at = now()
     where status in ('queued', 'running')
     returning id`);
  const ids = [...orphaned].map((r) => (r as { id: string }).id);
  if (ids.length === 0) return;
  await db.execute(dsql`
    update flow_node_runs
       set status = 'failed', finished_at = now()
     where status in ('pending', 'running')
       and flow_run_id = any(${ids}::uuid[])`);
  log(`flow orphan sweep: failed ${ids.length} run(s)`);
}

async function main() {
  // Single-runner guarantee via advisory lock on a dedicated connection.
  const lockConn = postgres(url, { max: 1 });
  const [{ locked }] = await lockConn`
    select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as locked`;
  if (!locked) {
    console.error(
      "[worker] another worker instance holds the lock — exiting.",
    );
    process.exit(1);
  }
  log("advisory lock acquired — single runner confirmed");

  await sweepOrphans();
  await sweepOrphanedFlowRuns().catch((e) => log(`flow orphan sweep failed: ${e}`));
  await syncSchedules();
  await syncRoutineCrons();
  await syncFlowCrons();

  // Module background jobs (e.g. knowledge ingestion, calendar sync).
  const moduleJobs = serverModules.flatMap((m) => m.jobs ?? []);
  const jobHandlers = new Map(
    moduleJobs.map((j) => [j.channel, j.handle] as const),
  );
  for (const job of moduleJobs) {
    if (!job.schedule) continue;
    new Cron(job.schedule, { protect: true }, () => {
      void runJob(job.channel, () => job.handle("", { db }));
    });
    log(`job "${job.channel}" scheduled [${job.schedule}]`);
  }
  // Warm run-on-boot jobs once, so a persisted cache is ready before the first
  // page load (idempotent jobs no-op when nothing changed).
  for (const job of moduleJobs) {
    if (!job.runOnBoot) continue;
    void runJob(job.channel, () => job.handle("", { db }));
    log(`job "${job.channel}" kicked on boot`);
  }

  // Dedicated LISTEN connection — made resilient. A Mac that sleeps leaves a
  // half-open socket that postgres.js won't notice on its own: writes succeed
  // into the void, no NOTIFY ever arrives, and every event-driven path (agent
  // hot-reload, run/cancel, approvals, Slack delivery, the verify button, Slack
  // intake) goes silently deaf until the process restarts. We subscribe all
  // channels on a fresh connection and let a heartbeat watchdog rebuild it when
  // its own pings stop coming back, then catch up on work missed while deaf.
  //
  // The health signal is a self-NOTIFY: every tick we NOTIFY `aios_heartbeat`
  // through the main pool and expect THIS connection to hear it. That exercises
  // the real LISTEN path end-to-end — a plain `SELECT 1` would run on a separate
  // pool connection and prove nothing about whether this socket still delivers.
  let lastHeartbeat = Date.now();
  const subscribeAll = async (l: ReturnType<typeof postgres>) => {
    await l.listen("aios_heartbeat", () => {
      lastHeartbeat = Date.now();
    });
    await l.listen("agents_changed", () => {
      log("agents_changed → resyncing schedules");
      syncSchedules().catch((e) => log(`resync failed: ${e}`));
    });
    await l.listen("routines_changed", () => {
      log("routines_changed → resyncing routine crons");
      syncRoutineCrons().catch((e) => log(`routine resync failed: ${e}`));
    });
    await l.listen("flows_changed", () => {
      log("flows_changed → resyncing flow crons");
      syncFlowCrons().catch((e) => log(`flow resync failed: ${e}`));
    });
    await l.listen("run_requests", (runId) => {
      // NOTIFY payloads are raw text; reject non-uuids so a malformed one fails
      // cleanly rather than corrupting the claim's query parameters.
      if (!UUID_RE.test(runId)) {
        log(`ignoring malformed run_requests payload: ${JSON.stringify(runId).slice(0, 60)}`);
        return;
      }
      log(`run request → ${runId}`);
      executeRun(runId).catch((e) => log(`run ${runId} failed: ${e}`));
    });
    await l.listen("approval_decisions", (approvalId) => {
      log(`approval decision → ${approvalId}`);
      executeApproval(approvalId).catch((e) =>
        log(`approval ${approvalId} failed: ${e}`),
      );
    });
    await l.listen("config_changed", (key) => {
      log(`config_changed → ${key} (routes re-read per run; noted)`);
    });
    // Slack delivery of notifications (skipped gracefully when unconfigured).
    await l.listen("notifications", (id) => {
      if (!id || id === "read") return;
      deliverToSlack(id).catch((e) => log(`slack delivery failed: ${e}`));
    });
    for (const [channel, handle] of jobHandlers) {
      await l.listen(channel, (payload) => {
        log(`job ${channel} ← ${payload}`);
        void runJob(channel, () => handle(payload, { db }));
      });
    }
  };

  const startListener = async () => {
    // Named so it's identifiable in pg_stat_activity (monitoring + the drop is
    // observable). max:1 — one dedicated connection carries every LISTEN.
    const l = postgres(url, {
      max: 1,
      connection: { application_name: "aios-worker-listener" },
    });
    await subscribeAll(l);
    return l;
  };

  let listener = await startListener();
  log(`listening on ${jobHandlers.size + 8} channel(s)`);

  const rebuildListener = async () => {
    try {
      await listener.end({ timeout: 5 });
    } catch {
      // dead socket — abandon it and move on
    }
    listener = await startListener();
    lastHeartbeat = Date.now(); // fresh grace window for the new subscription
    log("listener rebuilt — catching up (schedules + queued runs)");
    syncSchedules().catch((e) => log(`catch-up resync failed: ${e}`));
    syncRoutineCrons().catch((e) => log(`catch-up routine resync failed: ${e}`));
    syncFlowCrons().catch((e) => log(`catch-up flow resync failed: ${e}`));
    pickUpQueuedRuns().catch((e) => log(`catch-up queued pickup failed: ${e}`));
  };
  // Heartbeat watchdog: emit a beat every 30s and rebuild if none has come back
  // for 90s (≈3 missed) — the window that means this socket has gone deaf.
  const HEARTBEAT_MS = 30_000;
  const DEAF_AFTER_MS = 90_000;
  setInterval(() => {
    void (async () => {
      const silentFor = Date.now() - lastHeartbeat;
      if (silentFor > DEAF_AFTER_MS) {
        log(`⚠ listener deaf for ${Math.round(silentFor / 1000)}s — rebuilding`);
        await rebuildListener().catch((err) =>
          log(`listener rebuild failed, retry next tick: ${err}`),
        );
      }
      // Send through the main pool (which reconnects on its own); the listener
      // must echo it back to prove it's still delivering.
      sql.notify("aios_heartbeat", "").catch(() => {});
    })();
  }, HEARTBEAT_MS).unref();

  // Periodic safety net: orphan sweep + schedule resync + stale queued
  // pick-up every 5 minutes.
  new Cron("*/5 * * * *", () => {
    sweepOrphans().catch((e) => log(`safety-net orphan sweep failed: ${e}`));
    syncSchedules().catch((e) => log(`safety-net schedule sync failed: ${e}`));
    syncRoutineCrons().catch((e) => log(`safety-net routine sync failed: ${e}`));
    syncFlowCrons().catch((e) => log(`safety-net flow sync failed: ${e}`));
    pickUpQueuedRuns().catch((e) => log(`safety-net queued pickup failed: ${e}`));
  });

  // Nightly database backup (03:30) + catch-up at boot when the newest dump
  // is older than a day (covers a Mac that was asleep at 03:30).
  new Cron("30 3 * * *", { protect: true }, async () => {
    await runBackup(log);
  });
  if (!(await hasFreshBackup())) {
    log("no fresh backup found — running one now");
    runBackup(log).catch(() => {});
  }

  // Embedding sweep: local nomic-embed-text via Ollama, rows with NULL
  // embeddings only — idempotent, free, offline. First refresh the unified
  // search_index from the sources that don't own an embedding column (Gmail,
  // Calendar, Telegram, reports, People, Inbox, Workbench results, Ask answers),
  // then embed everything still missing a vector.
  new Cron("*/2 * * * *", { protect: true }, async () => {
    try {
      const { syncSearchIndex } = await import("@/core/search-index");
      await syncSearchIndex(log);
    } catch (e) {
      log(`search-index sync failed: ${String(e).slice(0, 120)}`);
    }
    try {
      const { sweepEmbeddings } = await import("@/core/embeddings");
      const n = await sweepEmbeddings(log);
      if (n > 0) log(`embedded ${n} row(s)`);
    } catch (e) {
      log(`embedding sweep failed (ollama down?): ${String(e).slice(0, 120)}`);
    }
  });

  // Area classification runs on its OWN cron: it calls a local LLM with up to
  // 5×60s of timeout budget, and sharing a `protect`ed tick with the index
  // sync meant a slow/missing model silently starved indexing + embedding.
  new Cron("*/5 * * * *", { protect: true }, async () => {
    // Sort newly-indexed items into their broad "area of development" drawer
    // (local LLM, topic-based). Bounded per tick so it never hogs Ollama.
    try {
      const { classifyAreas } = await import("@/core/area-classify");
      await classifyAreas(60, log);
    } catch (e) {
      log(`area classify failed: ${String(e).slice(0, 120)}`);
    }
  });

  // Nightly retention (03:10, before the 03:30 backup so the dump shrinks too):
  // the transcript of an old run is debugging material, not knowledge — the
  // run's `result` (what agents/search actually use) is kept. Without this,
  // `agent_runs` and `notifications` grow forever and every nightly pg_dump
  // gets larger with no bounded steady state.
  new Cron("10 3 * * *", { protect: true }, async () => {
    try {
      const [t, r, n, l] = await Promise.all([
        db.execute(dsql`update agent_runs set transcript='[]'::jsonb
          where finished_at < now() - interval '14 days'
            and transcript <> '[]'::jsonb`),
        db.execute(dsql`delete from agent_runs
          where finished_at < now() - interval '90 days'`),
        db.execute(dsql`delete from notifications
          where created_at < now() - interval '30 days'`),
        db.execute(dsql`delete from agent_ledger
          where processed_at < now() - interval '180 days'`),
      ]);
      const c = (x: unknown) => (x as { count?: number })?.count ?? 0;
      log(
        `retention: trimmed ${c(t)} transcript(s), deleted ${c(r)} old run(s), ${c(n)} old notification(s), ${c(l)} old ledger row(s)`,
      );
    } catch (e) {
      log(`retention sweep failed: ${String(e).slice(0, 120)}`);
    }
  });

  // Model-server health: the tick fires every 5 min, but the check only runs
  // every `healthcheck_interval_min` (default 60, 0 = off) and alerts (bell +
  // Slack) only on a state change — see core/health.ts.
  new Cron("*/5 * * * *", { protect: true }, async () => {
    try {
      const {
        HEALTHCHECK_INTERVAL_KEY,
        HEALTHCHECK_LAST_KEY,
        DEFAULT_HEALTHCHECK_INTERVAL_MIN,
        runHealthCheckAndNotify,
      } = await import("@/core/health");
      const raw = await getSetting(HEALTHCHECK_INTERVAL_KEY);
      const intervalMin =
        raw == null ? DEFAULT_HEALTHCHECK_INTERVAL_MIN : parseInt(raw, 10);
      if (!intervalMin || intervalMin <= 0) return; // disabled
      const last = parseInt((await getSetting(HEALTHCHECK_LAST_KEY)) || "0", 10);
      if (Date.now() - last < intervalMin * 60_000) return; // not due yet
      const statuses = await runHealthCheckAndNotify();
      const down = statuses.filter((s) => !s.ok).map((s) => s.label);
      log(
        `model-server health: ${down.length ? `DOWN — ${down.join(", ")}` : "all ok"}`,
      );
    } catch (e) {
      log(`health check failed: ${String(e).slice(0, 120)}`);
    }
  });

  // Catch up: execute any queued runs left from before boot.
  const queued = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.status, "queued"));
  for (const q of queued) {
    log(`resuming queued run ${q.id}`);
    executeRun(q.id).catch((e) => log(`run ${q.id} failed: ${e}`));
  }

  log(
    `ready — ${crons.size} scheduled agent(s), ${jobHandlers.size} job channel(s)`,
  );
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
