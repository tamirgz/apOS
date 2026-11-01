import type { ModuleServerManifest } from "@/core/modules/types.server";
import { inboxItems } from "./schema";
import { inboxJobs } from "./triage";
import { slackInboxJobs } from "./slack-capture";
import { inboxTools } from "./tools";
import { InboxPage } from "./pages/InboxPage";
import { InboxWidget } from "./widgets/InboxWidget";

export const inboxServerManifest: ModuleServerManifest = {
  id: "inbox",
  routes: {
    "": InboxPage,
  },
  widgets: [
    { id: "inbox", title: "Inbox", size: "sm", component: InboxWidget, priority: 1, span: 2 },
  ],
  schema: { inboxItems },
  aiTools: inboxTools,
  agentTemplates: [],
  jobs: [...inboxJobs, ...slackInboxJobs],
};
