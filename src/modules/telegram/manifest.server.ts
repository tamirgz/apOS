import type { ModuleServerManifest } from "@/core/modules/types.server";
import { telegramJobs } from "./ingest";
import { telegramChannels, telegramPosts } from "./schema";
import { TelegramChannelPage, TelegramPage } from "./pages/TelegramPage";

export const telegramServerManifest: ModuleServerManifest = {
  id: "telegram",
  routes: {
    "": TelegramPage,
    "[id]": TelegramChannelPage,
  },
  widgets: [],
  schema: { telegramChannels, telegramPosts },
  aiTools: [],
  agentTemplates: [],
  jobs: telegramJobs,
};
