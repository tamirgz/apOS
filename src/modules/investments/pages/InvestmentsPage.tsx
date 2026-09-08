import { GlassPanel } from "@/core/ui/GlassPanel";
import { isentryConfigured } from "../db";
import { InvestmentsChat } from "../components/InvestmentsChat";
import { InvestmentsTabs } from "../components/InvestmentsTabs";
import { PortfolioOverview } from "../components/PortfolioOverview";
import { ReportButton } from "../components/ReportButton";

/**
 * Investments page — two tabs: the portfolio presentation (server-rendered from
 * iSentry, read-only) and a persistent chat over it (portfolio tools + viz.chart).
 * apOS is the insight/chat layer; the holdings themselves live in iSentry.
 */
export async function InvestmentsPage() {
  const connected = isentryConfigured();
  return (
    <div className="flex flex-col gap-4">
      {connected ? (
        <InvestmentsTabs
          overview={<PortfolioOverview />}
          chat={<InvestmentsChat />}
          actions={
            <div className="flex items-center gap-3">
              <ReportButton />
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint sm:inline">
                iSentry · read-only
              </span>
            </div>
          }
        />
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
