import type { ModulePagesManifest } from "@/core/modules/types.server";
import { OrbitPage } from "./pages/OrbitPage";

export const orbitPagesManifest: ModulePagesManifest = {
  id: "orbit",
  routes: {
    "": OrbitPage,
  },
};
