import type { ModulePagesManifest } from "@/core/modules/types.server";
import { VaultPage } from "./pages/VaultPage";

export const obsidianPagesManifest: ModulePagesManifest = {
  id: "vault",
  routes: {
    "": VaultPage,
  },
};
