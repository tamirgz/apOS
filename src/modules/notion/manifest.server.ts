import type { ModuleServerManifest } from "@/core/modules/types.server";
import { notionPages } from "./schema";
import { notionJobs } from "./jobs";

export const notionServerManifest: ModuleServerManifest = {
  id: "notion",
  schema: { notionPages },
  aiTools: [],
  jobs: notionJobs,
  agentTemplates: [],
};
