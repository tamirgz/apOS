import type { AgentTemplate } from "@/core/modules/types.server";

/**
 * Investment insight agent — the "learns your activity and produces insight"
 * capability. Read→synthesize→remember, the same agentic shape as memory
 * consolidation, so it runs on the same FREE LOCAL model (never bills).
 *
 * SCOPE: descriptive and observational ONLY — concentration, drift, notable
 * moves, things to look at. It must NOT give buy/sell recommendations or
 * personalized investment advice; it reports what the numbers show.
 *
 * Manual-only (defaultSchedule: null) during validation — trigger it yourself,
 * judge the quality, and flip it to a weekly cron once it proves out.
 */
export const investmentInsightTemplate: AgentTemplate = {
  id: "investment-insight",
  name: "Investment insight",
  description:
    "Reviews your iSentry portfolio (positions + recent transactions) and writes a concise, honest, DESCRIPTIVE read — concentration, drift, notable moves — into memory so insight accrues over time. Free local model. Not financial advice.",
  defaultPrompt: [
    "Produce a SHORT, honest, DESCRIPTIVE read on the user's investment portfolio. Read-only. Not financial advice — no buy/sell/hold recommendations.",
    "GROUNDING RULE (critical): every number and every ticker in your output MUST come from a portfolio.* tool RESULT you receive in THIS run. Do NOT use prior knowledge, examples, or any other source for holdings or figures. If a tool didn't return it, do not write it.",
    "Steps: 1) portfolio.summary  2) portfolio.positions  3) portfolio.performance  4) portfolio.transactions (only to explain a specific move).",
    "Then write 3-6 observations grounded in the ACTUAL returned numbers (concentration, notable positions, trend). Cite the real USD figures.",
    "REQUIRED — every report must include a chart: call viz.chart with the real numbers (e.g. type 'hbar', unit 'currency', of your top ~10 positions by market value, or P&L by position) and put its returned `embed` markdown in your report. Do not describe a chart in words or JSON — only viz.chart makes one.",
    "Save your read with memory.remember so insight accrues across runs. Do not repeat an observation you already saved. Do NOT do project/task work — only investments.",
  ].join("\n"),
  defaultTools: [
    "portfolio.summary",
    "portfolio.positions",
    "portfolio.performance",
    "portfolio.transactions",
    "portfolio.byStrategy",
    "viz.chart",
  ],
  defaultSchedule: null, // manual-only during validation; flip to weekly once proven
  // ISOLATED: a focused, single-source, read-only agent — no shared-memory
  // recall injection, no memory.update. On a FAITHFUL model: the abliterated
  // fabricated the whole portfolio (won consolidation, but confabulates on
  // factual transcription); qwen3-coder:30b reads the real numbers correctly.
  defaultIsolated: true,
  defaultProvider: "ollama",
  defaultModel: "qwen3.5:35b-a3b-coding-nvfp4-32k",
  defaultFallbackModel: "qwen3-coder:30b",
  defaultTurnBudget: 14,
};
