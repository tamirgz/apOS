import type { ModulePagesManifest } from "@/core/modules/types.server";
import { InboxPage } from "./pages/InboxPage";

export const inboxPagesManifest: ModulePagesManifest = {
  id: "inbox",
  routes: {
    "": InboxPage,
  },
};
