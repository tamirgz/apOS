import type { ModulePagesManifest } from "@/core/modules/types.server";
import { GmailPage } from "./pages/GmailPage";

export const gmailPagesManifest: ModulePagesManifest = {
  id: "gmail",
  routes: {
    "": GmailPage,
  },
};
