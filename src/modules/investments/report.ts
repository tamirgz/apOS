"use server";

import { createTask } from "@/modules/workbench/actions";
import { getToolsByNames } from "@/core/ai/tool-registry";
import { db } from "@/core/db/client";

/**
 * The deep investment report is STAGED to stay reliable on a local model:
 *
 *   Stage 1 (here, in code) — DETERMINISTICALLY gather every figure and
 *   pre-build the charts. Gathering is a fixed set of tool calls, so letting the
 *   model orchestrate it only invited loops (it would gather, re-narrate its
 *   plan, gather again, and never start writing).
 *
 *   Stage 2 (the Workbench task) — a WRITE-ONLY task: the prompt already carries
 *   all the data and the finished chart embeds, so the model just composes the
 *   prose. No gathering, no tool loop — the thing that used to hang.
 *
 * Runs on the faithful MLX abliterated model (needs LM Studio warm). Editable
 * per-attempt in the Workbench — retry on Claude for a heavier pass.
 */
const REPORT_MODEL = "mlx/huihui-qwen3.6-35b-a3b-claude-4.7-opus-abliterated-mlx";

type ToolResult = Record<string, unknown>;

/** Call one apOS tool in-process with a bare db context. */
async function callTool(name: string, input: unknown): Promise<ToolResult> {
  const [tool] = getToolsByNames([name]);
  if (!tool) return { error: `tool ${name} not found` };
  try {
    return (await tool.execute(input, { db })) as ToolResult;
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

/** Build one chart in code and return its embed markdown (or "" on failure). */
async function buildChart(spec: {
  type: string;
  title: string;
  unit: "number" | "currency" | "percent";
  data: { label: string; value: number }[];
}): Promise<string> {
  if (!spec.data.length) return "";
  const res = await callTool("viz.chart", spec);
  return typeof res.embed === "string" ? res.embed : "";
}

// Postgres numeric columns arrive as strings via the SQL client, so coerce
// both — otherwise the performance chart would silently zero out.
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export async function createInvestmentReport(): Promise<{ id: string }> {
  // ── Stage 1: gather deterministically ────────────────────────────────────
  const [summary, allocation, positions, performance, algo, leopold, savings, quotes] =
    await Promise.all([
      callTool("portfolio.summary", {}),
      callTool("portfolio.allocation", { top: 8 }),
      callTool("portfolio.positions", { limit: 200 }),
      callTool("portfolio.performance", { days: 180 }),
      callTool("portfolio.byStrategy", { tag: "Algo" }),
      callTool("portfolio.byStrategy", { tag: "Leopold" }),
      callTool("portfolio.savings", {}),
      callTool("market.quote", { symbols: ["^GSPC", "^IXIC"] }),
    ]);

  // ── Pre-build the charts from the real data ───────────────────────────────
  const sumRow = (summary.summary ?? {}) as Record<string, unknown>;
  const pos = (positions.positions as Record<string, unknown>[]) ?? [];
  const holdingSlices =
    (allocation.slices as { label: string; value: number }[]) ?? [];
  const series =
    (performance.series as { date?: string; total_value_usd?: number }[]) ?? [];
  const isoDay = (d: unknown): string => {
    const t = d ? new Date(d as string) : null;
    return t && !Number.isNaN(t.getTime())
      ? t.toISOString().slice(0, 10)
      : String(d ?? "").slice(0, 10);
  };
  const perfData = series
    .map((p) => ({ label: isoDay(p.date), value: num(p.total_value_usd) ?? 0 }))
    .filter((d) => d.label && d.value > 0);

  // Allocation by MARKET (US / IL / CRYPTO / MY) — the iSentry portfolio split.
  const byMarket = new Map<string, number>();
  for (const p of pos) {
    const mkt = String(p.portfolio ?? "Other");
    byMarket.set(mkt, (byMarket.get(mkt) ?? 0) + (num(p.market_value_usd) ?? 0));
  }
  const marketData = [...byMarket.entries()]
    .map(([label, value]) => ({ label, value: +value.toFixed(2) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  // What drove the total return: cost basis, then gains stacking on top.
  const waterfallData = [
    { label: "Cost basis", value: +(num(sumRow.cost_basis_usd) ?? 0).toFixed(2) },
    { label: "Unrealized", value: +(num(sumRow.unrealized_pnl_usd) ?? 0).toFixed(2) },
    { label: "Realized", value: +(num(sumRow.realized_pnl_usd) ?? 0).toFixed(2) },
    { label: "Dividends", value: +(num(sumRow.dividends_usd) ?? 0).toFixed(2) },
  ].filter((d) => d.value !== 0);

  // Per-strategy P&L by symbol (Algo + Leopold).
  const stratPnl = (rows: unknown): { label: string; value: number }[] =>
    ((rows as Record<string, unknown>[]) ?? [])
      .map((s) => ({
        label: String(s.symbol ?? ""),
        value: +(
          (num(s.realized_pnl_usd) ?? 0) + (num(s.unrealized_pnl_usd) ?? 0)
        ).toFixed(2),
      }))
      .filter((d) => d.label)
      .sort((a, b) => b.value - a.value);
  const algoPnl = stratPnl(algo.bySymbol);
  const leopoldPnl = stratPnl(leopold.bySymbol);

  // Biggest winners & losers by unrealized P&L (top 6 each end).
  const posPnl = pos
    .map((p) => ({ label: String(p.symbol ?? ""), value: +(num(p.unrealized_pnl_usd) ?? 0).toFixed(2) }))
    .filter((d) => d.label && d.value !== 0)
    .sort((a, b) => b.value - a.value);
  const winnersLosers = [...posPnl.slice(0, 6), ...posPnl.slice(-6)].filter(
    (v, i, a) => a.findIndex((x) => x.label === v.label) === i,
  );

  const [marketEmbed, waterfallEmbed, perfEmbed, algoEmbed, leopoldEmbed, wlEmbed] =
    await Promise.all([
      buildChart({ type: "donut", title: "Allocation by market", unit: "currency", data: marketData }),
      buildChart({ type: "waterfall", title: "What drove the return — cost basis + gains", unit: "currency", data: waterfallData }),
      buildChart({ type: "area", title: "Portfolio value — last 180 days", unit: "currency", data: perfData }),
      buildChart({ type: "hbar", title: "Algo strategy — P&L by symbol", unit: "currency", data: algoPnl }),
      buildChart({ type: "hbar", title: "Leopold strategy — P&L by symbol", unit: "currency", data: leopoldPnl }),
      buildChart({ type: "hbar", title: "Biggest winners & losers — unrealized P&L", unit: "currency", data: winnersLosers }),
    ]);

  // ── Stage 2: a write-only task with everything already provided ───────────
  const today = new Date().toISOString().slice(0, 10);
  // Keep the digest compact + focused: summary, allocation, strategy totals,
  // the market split, top holdings, and the perf endpoints (the series lives in
  // the chart, not the prompt).
  const digest = JSON.stringify(
    {
      summary: sumRow,
      allocation_by_holding: holdingSlices,
      allocation_by_market: marketData,
      top_positions: pos.slice(0, 25),
      performance: { points: series.length, first: perfData[0], last: perfData[perfData.length - 1] },
      strategies: {
        Algo: { totals: algo.totals, caveats: algo.caveats, bySymbol: algo.bySymbol },
        Leopold: { totals: leopold.totals, caveats: leopold.caveats, bySymbol: leopold.bySymbol },
      },
      savings,
      benchmarks: quotes,
    },
    null,
    1,
  ).slice(0, 22000);

  const prompt = [
    "Write a THOROUGH, well-structured investment report on the user's portfolio. DESCRIPTIVE only — NOT financial advice, no buy/sell/hold recommendations.",
    "",
    "IMPORTANT: ALL the data you need is already provided below — do NOT call any tools. Do not try to gather anything. Just write the report now, grounding every number in the DATA block. Never invent figures.",
    "",
    "FORMATTING — match the house style of the app's other markdown reports:",
    "- Lead each section with a short prose paragraph, then a compact markdown TABLE for the figures (use tables for the overview numbers and the per-strategy totals).",
    "- **Bold** the headline numbers (total value, total return, each strategy's return %).",
    "- Keep it scannable: clear ## sections, tables over long number-laden sentences.",
    "",
    "Sections:",
    "## Executive summary — 3-4 sentences: total value, net P&L, the one-line story.",
    "## Portfolio overview — value, cost basis, unrealized/realized P&L, dividends as a table. Place the RETURN-COMPOSITION chart and the ALLOCATION-BY-MARKET chart here.",
    "## Performance & trend — describe the 180-day value trend vs the ^GSPC / ^IXIC benchmarks. Place the PERFORMANCE chart here.",
    "## Strategy breakdown — a table comparing Algo vs Leopold (invested, total return %, realized, unrealized). Place BOTH strategy P&L charts here. Flag any symbol carrying a `caveat`.",
    "## Positions of note — biggest winners and losers, concentration risk. Place the WINNERS & LOSERS chart here.",
    "## Observations & watch-items — 4-6 grounded observations and what's worth monitoring. Still no recommendations.",
    "",
    "CHART EMBEDS — copy each line VERBATIM into the named section (they render as interactive charts). Do not alter them:",
    waterfallEmbed && `- RETURN-COMPOSITION (Portfolio overview): ${waterfallEmbed}`,
    marketEmbed && `- ALLOCATION-BY-MARKET (Portfolio overview): ${marketEmbed}`,
    perfEmbed && `- PERFORMANCE (Performance & trend): ${perfEmbed}`,
    algoEmbed && `- ALGO P&L (Strategy breakdown): ${algoEmbed}`,
    leopoldEmbed && `- LEOPOLD P&L (Strategy breakdown): ${leopoldEmbed}`,
    wlEmbed && `- WINNERS & LOSERS (Positions of note): ${wlEmbed}`,
    "",
    "End with a 2-line summary of what you produced.",
    "",
    `=== DATA (as of ${today}) ===`,
    digest,
  ]
    .filter(Boolean)
    .join("\n");

  const task = await createTask({
    prompt,
    taskType: "docs",
    executorId: "native",
    model: REPORT_MODEL,
    createdFrom: "investments",
  });
  return { id: task.id };
}
