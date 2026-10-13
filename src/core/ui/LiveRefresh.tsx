"use client";

import { useLiveEvents } from "./useLiveEvents";

/**
 * Drop-in for server components: refreshes the route when one of `channels`
 * fires. Renders nothing.
 */
export function LiveRefresh({ channels, delayMs }: { channels: string[]; delayMs?: number }) {
  useLiveEvents(channels, undefined, { delayMs });
  return null;
}
