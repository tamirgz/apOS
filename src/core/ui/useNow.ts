"use client";

import { useEffect, useState } from "react";

/**
 * A stable "now" for render-time date math (overdue, "last 14 days"…). Read
 * once per mount so renders stay pure; a refresh or remount moves it forward.
 * Pass `tickMs` for a view that stays open for hours and must keep moving.
 */
export function useNow(tickMs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tickMs) return;
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}
