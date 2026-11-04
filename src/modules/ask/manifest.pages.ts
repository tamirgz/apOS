import type { ModulePagesManifest } from "@/core/modules/types.server";
import { AskPage } from "./pages/AskPage";

export const askPagesManifest: ModulePagesManifest = {
  id: "ask",
  routes: {
    "": AskPage,
  },
};
