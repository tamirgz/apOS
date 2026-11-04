import type { ModuleServerManifest } from "@/core/modules/types.server";
import { inboxItems } from "./schema";
import { inboxJobs } from "./triage";
import { slackInboxJobs } from "./slack-capture";
import { inboxTools } from "./tools";

export const inboxServerManifest: ModuleServerManifest = {
  id: "inbox",
  schema: { inboxItems },
  aiTools: inboxTools,
  agentTemplates: [],
  jobs: [...inboxJobs, ...slackInboxJobs],
};
