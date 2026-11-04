import type { ModuleWidgets } from "@/core/modules/types.server";
import { InboxWidget } from "./widgets/InboxWidget";

export const inboxWidgets: ModuleWidgets = {
  id: "inbox",
  widgets: [
    { id: "inbox", title: "Inbox", size: "sm", component: InboxWidget, priority: 1, span: 2 },
  ],
};
