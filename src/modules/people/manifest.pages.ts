import type { ModulePagesManifest } from "@/core/modules/types.server";
import { PeoplePage } from "./pages/PeoplePage";
import { PersonDetailPage } from "./pages/PersonDetailPage";

export const peoplePagesManifest: ModulePagesManifest = {
  id: "people",
  routes: {
    "": PeoplePage,
    "[id]": PersonDetailPage,
  },
};
