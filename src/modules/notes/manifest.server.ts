import type { ModuleServerManifest } from "@/core/modules/types.server";
import { notes } from "./schema";
import { noteTools } from "./tools";
import { NotesPage } from "./pages/NotesPage";
import { NoteDetailPage } from "./pages/NoteDetailPage";

export const notesServerManifest: ModuleServerManifest = {
  id: "notes",
  routes: {
    "": NotesPage,
    "[id]": NoteDetailPage,
  },
  widgets: [],
  schema: { notes },
  aiTools: noteTools,
  agentTemplates: [],
};
