import { getSetting } from "@/core/app-settings";
import { DEFAULT_HEALTHCHECK_INTERVAL_MIN } from "@/core/health";
import { INTEGRATIONS } from "@/core/integrations/registry";
import { AuthPanel } from "../components/AuthPanel";
import { GoogleConnectBanner } from "../components/GoogleConnectBanner";
import { HealthCheckCard } from "../components/HealthCheckCard";
import { IntegrationsEditor } from "../components/IntegrationsEditor";
import { SettingsNav } from "../components/SettingsNav";

const SERVER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  mlx: "LM Studio (MLX)",
};

/** Settings · Connections — subscription auth + external integrations. */
export async function ConnectionsPage() {
  // Load every registry field's current value in one pass, so the editor renders
  // entirely from the registry (no per-key prop plumbing).
  const keys = [...new Set(INTEGRATIONS.flatMap((i) => i.fields.map((f) => f.key)))];
  const entries = await Promise.all(
    keys.map(async (k) => [k, (await getSetting(k)) ?? ""] as const),
  );
  const values = Object.fromEntries(entries);
  const googleConnected = !!(await getSetting("google_refresh_token"));

  // Health-check config + last-known server status (no live ping on page load —
  // that would stall render up to the probe timeout if a server is down).
  const rawInterval = await getSetting("healthcheck_interval_min");
  const healthInterval =
    rawInterval == null ? DEFAULT_HEALTHCHECK_INTERVAL_MIN : parseInt(rawInterval, 10);
  let lastState: Record<string, boolean> = {};
  try {
    lastState = JSON.parse((await getSetting("healthcheck_state")) || "{}");
  } catch {
    lastState = {};
  }
  const initialStatuses = Object.entries(lastState).map(([id, ok]) => ({
    id,
    label: SERVER_LABELS[id] ?? id,
    url: "",
    ok: !!ok,
  }));

  return (
    <div className="max-w-3xl">
      <SettingsNav />
      <div className="flex flex-col gap-5">
        <GoogleConnectBanner />
        <AuthPanel />
        <HealthCheckCard interval={healthInterval} initialStatuses={initialStatuses} />
        <IntegrationsEditor values={values} googleConnected={googleConnected} />
      </div>
    </div>
  );
}
