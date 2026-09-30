import { act, done, info } from "@/core/ui/feedback";
import { requestRun } from "../actions";

/** "Run now" with feedback: queued, already running, or why it failed. */
export async function runNow(agentId: string) {
  const r = await act(() => requestRun(agentId), { failed: "Couldn't start the run" });
  if (!r.ok) return;
  const href = `/m/agents/${agentId}`;
  if (r.value.alreadyRunning) info("Already running — this run is still going", { href });
  else done("Run queued", { href });
}
