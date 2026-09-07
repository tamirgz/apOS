"use client";

import { startTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type Listener = (channel: string, payload: string) => void;

/**
 * ONE EventSource per browser tab, shared by every subscriber. Each SSE
 * client holds a dedicated Postgres LISTEN connection server-side, so
 * per-component streams would multiply DB connections for no benefit.
 */
let es: EventSource | null = null;
const listeners = new Set<Listener>();

function ensureStream() {
  if (es) return;
  es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      const { channel, payload } = JSON.parse(e.data) as {
        channel: string;
        payload: string;
      };
      for (const l of listeners) l(channel, payload);
    } catch {
      // ignore malformed frames
    }
  };
  es.onerror = () => {
    // Browser auto-reconnects EventSource; nothing to do.
  };
}

function releaseStream() {
  if (listeners.size === 0 && es) {
    es.close();
    es = null;
  }
}

/**
 * Subscribe to server NOTIFY channels and refresh server-component data when
 * relevant channels fire (debounced — transcripts can NOTIFY very often).
 */
export function useLiveEvents(
  channels: string[],
  onEvent?: (channel: string, payload: string) => void,
) {
  const router = useRouter();
  const onEventRef = useRef(onEvent);
  // Keep the latest callback without re-subscribing — written in an effect,
  // not during render (a render-phase ref write trips react-hooks and can
  // desync under concurrent features).
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  const channelsKey = channels.join(",");

  useEffect(() => {
    const wanted = new Set(channelsKey.split(","));
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const listener: Listener = (channel, payload) => {
      if (!wanted.has(channel)) return;
      onEventRef.current?.(channel, payload);
      if (refreshTimer) clearTimeout(refreshTimer);
      // Refresh INSIDE a transition. A bare router.refresh() re-suspends the
      // whole route segment, so React drops to the nearest Suspense fallback —
      // the shell's loading.tsx skeleton — and the template.tsx entrance
      // animation replays: the "loading…" flicker on every live event (which,
      // during an active run, fires ~every 1.5s). In a transition React keeps
      // the current content on screen and swaps it only once the new tree is
      // ready, so live updates arrive seamlessly with no fallback flash.
      refreshTimer = setTimeout(() => startTransition(() => router.refresh()), 350);
    };

    listeners.add(listener);
    ensureStream();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      listeners.delete(listener);
      releaseStream();
    };
  }, [channelsKey, router]);
}
