import { SectionTabs } from "@/core/ui/SectionTabs";
import { ExecutorsPanel } from "../components/ExecutorsPanel";
import { listExecutors } from "../queries";
import { getFreeModelHealthSummary, listFreeModelsByExecutor } from "../models";

/** Runs · Executors — which coding CLIs a run can use, and their models. */
export async function ExecutorsPage() {
  const executors = await listExecutors();
  const [modelsByExecutor, freeModelHealth] = await Promise.all([
    listFreeModelsByExecutor(executors.map((x) => x.id)),
    getFreeModelHealthSummary(),
  ]);
  return (
    <div className="max-w-4xl">
      <SectionTabs section="automation" />
      <ExecutorsPanel
        executors={executors}
        modelsByExecutor={modelsByExecutor}
        freeModelHealth={freeModelHealth}
      />
    </div>
  );
}
