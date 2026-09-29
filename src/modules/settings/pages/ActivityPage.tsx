import { ActivityPanel } from "../components/ActivityPanel";
import { SettingsNav } from "../components/SettingsNav";

/** Settings · Activity — which parts of apOS you actually use. */
export function ActivityPage() {
  return (
    <div className="max-w-4xl">
      <SettingsNav />
      <ActivityPanel />
    </div>
  );
}
