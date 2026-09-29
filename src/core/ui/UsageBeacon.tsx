"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { track } from "./telemetry";

/**
 * Records one "view" event per client-side navigation. Collapses UUIDs in the
 * path into ":id" in `meta.route` so the usage panel can group
 * /m/projects/<a> and /m/projects/<b> as the same page, while `path` keeps the
 * exact URL. Renders nothing.
 */
export function UsageBeacon() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || pathname === last.current) return;
    last.current = pathname;
    const route = pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
    track("view", { path: pathname, meta: { route } });
  }, [pathname]);
  return null;
}
