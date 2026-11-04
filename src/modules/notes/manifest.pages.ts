import type { ModulePagesManifest } from "@/core/modules/types.server";
import { NotesPage } from "./pages/NotesPage";
import { NoteDetailPage } from "./pages/NoteDetailPage";

export const notesPagesManifest: ModulePagesManifest = {
  id: "notes",
  routes: {
    "": NotesPage,
    "[id]": NoteDetailPage,
  },
};
