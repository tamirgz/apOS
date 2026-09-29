"use client";

import { useState } from "react";

/**
 * A stable "now" for render-time date math (overdue, "last 14 days"…). Read
 * once per mount so renders stay pure; a refresh or remount moves it forward.
 */
export function useNow(): number {
  const [now] = useState(() => Date.now());
  return now;
}
