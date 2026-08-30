"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";

/**
 * Shows the outcome of the Google OAuth dance. The callback redirects here
 * with ?google=connected | <error>; before this banner the flow ended on a
 * page that never acknowledged either way. Reads window.location (module
 * routes don't thread searchParams) and strips the param once shown.
 */
export function GoogleConnectBanner() {
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("google");
    if (!v) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot init from the URL, then the param is consumed
    setResult(v);
    url.searchParams.delete("google");
    window.history.replaceState(null, "", url.toString());
  }, []);

  if (!result) return null;
  const ok = result === "connected";
  return (
    <div
      className={
        ok
          ? "glass flex items-center gap-2.5 rounded-xl border border-plasma/25 p-3 text-sm text-ink"
          : "glass flex items-center gap-2.5 rounded-xl border border-flare/25 p-3 text-sm text-ink"
      }
    >
      {ok ? (
        <CheckCircle2 className="size-4 shrink-0 text-plasma" />
      ) : (
        <XCircle className="size-4 shrink-0 text-flare" />
      )}
      <span className="min-w-0 flex-1">
        {ok
          ? "Google connected — calendar and mail will sync on the next pass."
          : `Google connect failed: ${result}`}
      </span>
      <button
        type="button"
        onClick={() => setResult(null)}
        className="rounded-md p-1 text-ink-faint transition hover:text-ink"
        title="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
