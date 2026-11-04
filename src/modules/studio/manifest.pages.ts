import type { ModulePagesManifest } from "@/core/modules/types.server";
import { StudioPage } from "./pages/StudioPage";
import { FlowEditorPage } from "./pages/FlowEditorPage";

export const studioPagesManifest: ModulePagesManifest = {
  id: "studio",
  routes: {
    "": StudioPage,
    "[id]": FlowEditorPage,
  },
};
