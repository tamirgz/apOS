import { loadWorkData } from "../queries";
import { WorkView } from "../components/WorkView";

/** /m/tasks — all work across projects: board, list, and the features roadmap. */
export async function TasksPage() {
  return <WorkView data={await loadWorkData()} />;
}
