import { GlassPanel } from "@/core/ui/GlassPanel";
import { isentryConfigured } from "../db";
import { InvestmentsChat } from "../components/InvestmentsChat";
import { PortfolioOverview } from "../components/PortfolioOverview";
import { ReportButton } from "../components/ReportButton";

/**
 * Investments page — a persistent chat over the portfolio (apOS is the insight/
 * chat layer; the holdings themselves live in iSentry). The chat has the
 * portfolio tools + viz.chart, and survives reloads.
 */
export async function InvestmentsPage() {
  const connected = isentryConfigured();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {connected && <ReportButton />}
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-ink-faint">
            {connected ? "connected to iSentry · read-only" : "not connected"}
          </span>
        </div>
      </div>

      {connected ? (
        <>
          <PortfolioOverview />
          <InvestmentsChat />
        </>
      ) : (
        <GlassPanel className="px-8 py-16 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
            iSentry not connected
          </p>
          <p className="mx-auto mt-4 max-w-md text-sm text-ink-dim">
            Set <code className="text-ink">ISENTRY_DATABASE_URL</code> (a read-only
            Supabase connection string) in{" "}
            <code className="text-ink">.env.local</code> and restart.
          </p>
        </GlassPanel>
      )}
    </div>
  );
}
