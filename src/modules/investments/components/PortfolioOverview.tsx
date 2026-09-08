import { cn } from "@/core/ui/cn";
import {
  listPositions,
  performanceSnapshots,
  portfolioSummary,
} from "../queries";

const fmtUsd = (v: number | string | null | undefined, digits = 0) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });

const fmtPct = (v: number | null) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

const pnlColor = (v: number | null | undefined) =>
  v == null ? "text-ink-dim" : Number(v) >= 0 ? "text-plasma" : "text-flare";

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="glass rounded-xl p-4">
      <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
        {label}
      </p>
      <p className={cn("mt-1 font-display text-xl font-semibold tabular-nums", tone ?? "text-ink")}>
        {value}
      </p>
      {sub && <p className="mt-0.5 font-mono text-[10px] tabular-nums text-ink-faint">{sub}</p>}
    </div>
  );
}

/** 180-day portfolio value as a server-rendered SVG area — no client JS. */
function ValueChart({
  points,
}: {
  points: { date: string; value: number }[];
}) {
  if (points.length < 2) return null;
  const W = 600;
  const H = 110;
  const PAD = 4;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const up = last.value >= first.value;
  const stroke = up ? "var(--color-plasma)" : "var(--color-flare)";

  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          portfolio value · {points.length}d
        </p>
        <p className={cn("font-mono text-[10px] tabular-nums", pnlColor(last.value - first.value))}>
          {fmtPct(((last.value - first.value) / first.value) * 100)} over the period
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label="Portfolio value over time">
        <polygon
          points={`${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`}
          fill={stroke}
          opacity="0.08"
        />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] tabular-nums text-ink-faint">
        <span>{new Date(first.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {fmtUsd(first.value)}</span>
        <span>{new Date(last.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {fmtUsd(last.value)}</span>
      </div>
    </div>
  );
}

/** A holdings row shape (from listPositions). Loose — iSentry rows are untyped. */
type Holding = Record<string, unknown>;
interface PortfolioGroup {
  name: string;
  holdings: Holding[];
  total: number;
  cost: number;
  unreal: number;
}

/** One portfolio's holdings, weighted WITHIN that portfolio (value / portfolio total). */
function PortfolioSection({ g, grandTotal }: { g: PortfolioGroup; grandTotal: number }) {
  const share = grandTotal > 0 ? (g.total / grandTotal) * 100 : 0;
  const unrealPct = g.cost > 0 ? (g.unreal / g.cost) * 100 : null;
  const holdings = [...g.holdings].sort(
    (a, b) => Number(b.market_value_usd ?? 0) - Number(a.market_value_usd ?? 0),
  );
  return (
    <div className="glass overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-white/6 px-4 py-2.5">
        <span className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
          {g.name}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          {g.holdings.length} positions
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ion">
            {share.toFixed(1)}% of total
          </span>
          <span className="tabular-nums text-sm text-ink">{fmtUsd(g.total)}</span>
          <span className={cn("tabular-nums text-xs", pnlColor(g.unreal))}>
            {fmtUsd(g.unreal)}
            {unrealPct != null && <span className="ml-1 opacity-80">{fmtPct(unrealPct)}</span>}
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/6 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
              <th className="px-4 py-2 text-left font-normal">symbol</th>
              <th className="px-2 py-2 text-right font-normal">qty</th>
              <th className="px-2 py-2 text-right font-normal">avg cost</th>
              <th className="px-2 py-2 text-right font-normal">price</th>
              <th className="px-2 py-2 text-right font-normal">value</th>
              <th className="px-2 py-2 text-right font-normal">unrealized</th>
              <th className="px-4 py-2 text-left font-normal">weight in {g.name}</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const value = Number(h.market_value_usd ?? 0);
              const cost = Number(h.cost_basis_usd ?? 0);
              const pnl = h.unrealized_pnl_usd == null ? null : Number(h.unrealized_pnl_usd);
              const pnlPct = cost > 0 && pnl != null ? (pnl / cost) * 100 : null;
              // Weight is within THIS portfolio, not the whole book.
              const weight = g.total > 0 ? (value / g.total) * 100 : 0;
              return (
                <tr key={`${g.name}:${String(h.symbol)}`} className="border-b border-white/4 last:border-0 hover:bg-white/2">
                  <td className="px-4 py-2">
                    <span className="text-ink">{String(h.symbol)}</span>
                    {h.name != null && (
                      <span className="ml-2 hidden text-xs text-ink-faint md:inline">
                        {String(h.name).slice(0, 28)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-dim">
                    {Number(h.current_quantity).toLocaleString()}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-dim">
                    {fmtUsd(h.average_cost_usd as number, 2)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-dim">
                    {fmtUsd(h.current_price_usd as number, 2)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink">{fmtUsd(value)}</td>
                  <td className={cn("px-2 py-2 text-right tabular-nums", pnlColor(pnl))}>
                    {fmtUsd(pnl)}
                    {pnlPct != null && <span className="ml-1.5 text-xs opacity-80">{fmtPct(pnlPct)}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/6">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-ion/50 to-ion"
                          style={{ width: `${Math.min(100, weight)}%` }}
                        />
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                        {weight.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The portfolio at a glance, server-rendered from iSentry's read-only views.
 * Holdings are grouped by iSentry portfolio (US / MY / IL / Crypto), each with
 * its own total, share of the whole book, and per-portfolio weights.
 */
export async function PortfolioOverview() {
  const [summary, positions, snapshots] = await Promise.all([
    portfolioSummary(),
    listPositions(500), // all open holdings — grouped below
    performanceSnapshots(180),
  ]);

  const marketValue = Number(summary?.market_value_usd ?? 0);
  const costBasis = Number(summary?.cost_basis_usd ?? 0);
  const unrealized = summary?.unrealized_pnl_usd == null ? null : Number(summary.unrealized_pnl_usd);
  const unrealizedPct = costBasis > 0 && unrealized != null ? (unrealized / costBasis) * 100 : null;

  // Group holdings by portfolio, then order portfolios by size.
  const byPortfolio = new Map<string, Holding[]>();
  for (const h of positions as Holding[]) {
    const key = (h.portfolio as string) || "—";
    const arr = byPortfolio.get(key);
    if (arr) arr.push(h);
    else byPortfolio.set(key, [h]);
  }
  const groups: PortfolioGroup[] = [...byPortfolio.entries()]
    .map(([name, holdings]) => ({
      name,
      holdings,
      total: holdings.reduce((s, h) => s + Number(h.market_value_usd ?? 0), 0),
      cost: holdings.reduce((s, h) => s + Number(h.cost_basis_usd ?? 0), 0),
      unreal: holdings.reduce((s, h) => s + Number(h.unrealized_pnl_usd ?? 0), 0),
    }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  const points = [...snapshots]
    .filter((s) => s.total_value_usd != null)
    .map((s) => ({ date: String(s.date), value: Number(s.total_value_usd) }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="market value" value={fmtUsd(marketValue)} sub={`cost ${fmtUsd(costBasis)}`} />
        <Stat
          label="unrealized p&l"
          value={fmtUsd(unrealized)}
          sub={fmtPct(unrealizedPct)}
          tone={pnlColor(unrealized)}
        />
        <Stat
          label="realized p&l"
          value={fmtUsd(summary?.realized_pnl_usd)}
          tone={pnlColor(summary?.realized_pnl_usd == null ? null : Number(summary.realized_pnl_usd))}
        />
        <Stat label="dividends" value={fmtUsd(summary?.dividends_usd)} />
        <Stat label="open positions" value={String(summary?.positions ?? 0)} />
      </div>

      <ValueChart points={points} />

      {/* Allocation across portfolios — each portfolio's share of the whole book. */}
      <div className="glass rounded-xl p-4">
        <p className="mb-3 font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
          allocation · by portfolio
        </p>
        <div className="flex flex-col gap-2.5">
          {groups.map((g) => {
            const share = grandTotal > 0 ? (g.total / grandTotal) * 100 : 0;
            return (
              <div key={g.name} className="flex items-center gap-3">
                <span className="w-14 shrink-0 font-mono text-[11px] uppercase tracking-wide text-ink">
                  {g.name}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/6">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-plasma/50 to-plasma"
                    style={{ width: `${Math.min(100, share)}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-dim">
                  {share.toFixed(1)}%
                </span>
                <span className="hidden w-24 shrink-0 text-right tabular-nums text-sm text-ink sm:inline">
                  {fmtUsd(g.total)}
                </span>
                <span className={cn("hidden w-20 shrink-0 text-right tabular-nums text-xs sm:inline", pnlColor(g.unreal))}>
                  {fmtUsd(g.unreal)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Holdings grouped per portfolio, weighted within each. */}
      {groups.map((g) => (
        <PortfolioSection key={g.name} g={g} grandTotal={grandTotal} />
      ))}
    </div>
  );
}
