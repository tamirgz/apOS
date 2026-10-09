import type { ModuleJob } from "@/core/modules/types.server";
import { expireStaleAgentCards, pruneAttention, wakeSnoozed } from "./core";

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
      const expired = await expireStaleAgentCards();
      if (expired) console.log(`[attention_sweep] expired ${expired} stale agent card(s)`);
      await pruneAttention();
    },
  },
  {
    // Deterministic day planner — replaces the old LLM "Daily planner" agent.
    // Workday (Sun–Thu) mornings; also runnable on demand via NOTIFY "today.plan".
    channel: "today.plan",
    schedule: "30 7 * * 0-4",
    handle: async () => {
      const { planDay } = await import("./planner");
      const { raised, closed } = await planDay();
      console.log(`[today.plan] raised ${raised}, closed ${closed} attention card(s)`);
    },
  },
];
