import type { ModulePagesManifest } from "@/core/modules/types.server";
import { InvestmentsPage } from "./pages/InvestmentsPage";

export const investmentsPagesManifest: ModulePagesManifest = {
  id: "investments",
  routes: { "": InvestmentsPage },
};
