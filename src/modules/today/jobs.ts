import type { ModuleJob } from "@/core/modules/types.server";
import { pruneAttention, wakeSnoozed } from "./core";

/**
 * Heartbeat maintenance for the attention spine. Re-opens snoozed cards when
 * their time comes (so a snooze is reliable even if the app was closed) and
 * prunes long-dead rows. Every 5 minutes, cheap.
 */
export const todayJobs: ModuleJob[] = [
  {
    channel: "attention_sweep",
    schedule: "*/5 * * * *",
    handle: async () => {
      await wakeSnoozed();
      await pruneAttention();
    },
  },
  {
    // Deterministic day planner — replaces the old LLM "Daily planner" agent.
    // Weekday mornings; also runnable on demand via NOTIFY "today.plan".
    channel: "today.plan",
    schedule: "30 7 * * 1-5",
    handle: async () => {
      const { planDay } = await import("./planner");
      const { raised, closed } = await planDay();
      console.log(`[today.plan] raised ${raised}, closed ${closed} attention card(s)`);
    },
  },
];
