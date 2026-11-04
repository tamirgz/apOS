import type { ModulePagesManifest } from "@/core/modules/types.server";
import { TodayPage } from "./pages/TodayPage";
import { QueuePage } from "./pages/QueuePage";
import { PlanPage } from "./pages/PlanPage";

export const todayPagesManifest: ModulePagesManifest = {
  id: "today",
  routes: {
    "": TodayPage,
    queue: QueuePage,
    // The Plan screen: /m/today/plan is today, /m/today/plan/YYYY-MM-DD another day.
    plan: PlanPage,
    "plan/[id]": PlanPage,
  },
};
