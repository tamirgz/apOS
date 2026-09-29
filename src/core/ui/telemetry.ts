"use client";

/**
 * Client-side usage beacon. `track("work.create", { entityRef })` records a key
 * action; page views are recorded by <UsageBeacon/> in the shell layout.
 * Fire-and-forget via sendBeacon (survives navigation/unload); never throws.
 */
export function track(
  event: string,
  opts: { entityRef?: string; meta?: Record<string, unknown>; path?: string } = {},
): void {
  try {
    const payload = JSON.stringify({
      event,
      path: opts.path ?? window.location.pathname,
      entityRef: opts.entityRef,
      meta: opts.meta,
    });
    const blob = new Blob([payload], { type: "text/plain" });
    if (!navigator.sendBeacon?.("/api/telemetry", blob)) {
      void fetch("/api/telemetry", { method: "POST", body: payload, keepalive: true }).catch(() => {});
    }
  } catch {
    // telemetry is best-effort
  }
}
