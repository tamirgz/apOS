import type { ModulePagesManifest } from "@/core/modules/types.server";
import { CalendarPage } from "./pages/CalendarPage";

export const calendarPagesManifest: ModulePagesManifest = {
  id: "calendar",
  routes: {
    "": CalendarPage,
  },
};
