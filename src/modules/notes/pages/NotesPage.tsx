import { listNotes } from "../actions";
import { NotesGrid } from "../components/NotesGrid";

export async function NotesPage() {
  const { listProjects } = await import("@/modules/projects/actions");
  const [notes, projects] = await Promise.all([
    listNotes(),
    listProjects().catch(() => []),
  ]);
  const projectInfo = Object.fromEntries(
    projects.map((p) => [
      p.id,
      { name: p.name, category: p.category ?? null, kind: p.kind },
    ]),
  );
  return <NotesGrid notes={notes} projectInfo={projectInfo} />;
}
