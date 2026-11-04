import type { ModuleServerManifest } from "@/core/modules/types.server";
import { telegramJobs } from "./ingest";
import { telegramChannels, telegramPosts } from "./schema";

export const telegramServerManifest: ModuleServerManifest = {
  id: "telegram",
  schema: { telegramChannels, telegramPosts },
  aiTools: [],
  agentTemplates: [],
  jobs: telegramJobs,
};
