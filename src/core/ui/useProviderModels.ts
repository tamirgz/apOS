"use client";

import { useEffect, useState } from "react";
import type { AIProviderId } from "@/core/db/schema/ai-routes";

/**
 * Live-fetches the model list for a provider (via /api/ai/models) — shared by
 * every provider+model picker (Settings routing, per-agent model override).
 * Pass "" to clear (no provider selected yet).
 */
export function useProviderModels(provider: AIProviderId | "") {
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A new provider starts from an empty list — reset while rendering, not in
  // the effect (React's "adjust state when a prop changes" pattern).
  const [prevProvider, setPrevProvider] = useState(provider);
  if (provider !== prevProvider) {
    setPrevProvider(provider);
    setModels([]);
    setError(null);
  }

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    fetch(`/api/ai/models?provider=${provider}`)
      .then((r) => r.json())
      .then((d: { models: string[]; error?: string }) => {
        if (cancelled) return;
        setModels(d.models);
        if (d.error) setError(d.error);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  return { models, error };
}
