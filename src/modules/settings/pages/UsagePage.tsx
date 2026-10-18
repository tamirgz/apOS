import { CostPanel } from "../components/CostPanel";
import { UsagePanel } from "../components/UsagePanel";
import { SettingsNav } from "../components/SettingsNav";

/** Settings · Usage — token spend / cost. */
export function UsagePage() {
  return (
    <div className="max-w-4xl">
      <SettingsNav />
      <div className="flex flex-col gap-5">
        <CostPanel />
        <UsagePanel />
      </div>
    </div>
  );
}
