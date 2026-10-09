/**
 * Number grounding for the investments chat. The local model was writing
 * figures that no tool returned, e.g. "MU — 2 shares at $92.22/share =
 * $1,845.48" when MU's real cost basis is $2,187.96, or "27 open positions"
 * when 3 are open. Prompt rules alone didn't stop it. So the app now:
 *  - builds the open-positions table itself, straight from tool data, and
 *  - checks every $ and % figure in the model's prose against the tool
 *    results; a figure that matches nothing is "unverified".
 * Pure functions; the chat route decides what to do with the verdicts.
 */

/** "list my open Algo positions", "what do I still hold", "positions … state". */
export function wantsOpenPositions(msg: string): boolean {
  return /\bopen (positions?|holdings?|trades?)\b|\bstill (hold|own)|\bcurrently (hold|own)|\bholding now\b|\bpositions?\b.*\b(state|status)\b/i.test(
    msg,
  );
}

type OpenPosition = {
  symbol: unknown;
  shares: number;
  avg_cost_usd: number | null;
  current_price_usd: number | null;
  cost_basis_usd: number | null;
  market_value_usd: number;
  unrealized_pnl_usd: number;
  unrealized_pct: number | null;
};

const usd = (n: number | null) =>
  n == null
    ? "—"
    : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);

/** Markdown table of a strategy's open positions, from portfolio.byStrategy's result. */
export function openPositionsTable(byStrategy: Record<string, unknown>): string {
  const tag = String(byStrategy.tag ?? "");
  const open = (byStrategy.open_positions ?? []) as OpenPosition[];
  const closed = Number(byStrategy.closed_count) || 0;
  const head = `## ${tag} — open positions (${open.length})`;
  const closedNote = `${closed} other ${tag} symbol${closed === 1 ? " was" : "s were"} traded and fully closed.`;
  if (!open.length) return `${head}\n\nNo ${tag} positions are open. ${closedNote}`;
  const rows = open.map(
    (p) =>
      `| ${p.symbol} | ${p.shares} | ${usd(p.avg_cost_usd)} | ${usd(p.current_price_usd)} | ${usd(p.cost_basis_usd)} | ${usd(p.market_value_usd)} | ${usd(p.unrealized_pnl_usd)} | ${pct(p.unrealized_pct)} |`,
  );
  const value = open.reduce((a, p) => a + p.market_value_usd, 0);
  const pnl = open.reduce((a, p) => a + p.unrealized_pnl_usd, 0);
  return [
    head,
    "",
    "| Symbol | Shares | Avg cost | Price | Cost basis | Value | Unrealized | % |",
    "|---|--:|--:|--:|--:|--:|--:|--:|",
    ...rows,
    `| **Total** | | | | | **${usd(value)}** | **${usd(pnl)}** | |`,
    "",
    `${closedNote} Figures are from portfolio.byStrategy, in USD.`,
  ].join("\n");
}

/** Every finite number anywhere in a tool result. */
export function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) out.push(Number(value));
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

/**
 * The numbers stored under percentage-like keys (return_pct, change_pct,
 * margin_of_safety_percent…). A "3%" must match one of these, not any 3 in a
 * result: "open_count: 3" made "3% of the total investment" look supported.
 */
export function percentsIn(value: unknown, out: number[] = [], key = ""): number[] {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (/pct|percent|weight|rate|yield|change/i.test(key)) out.push(value);
  } else if (Array.isArray(value)) for (const v of value) percentsIn(v, out, key);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) percentsIn(v, out, k);
  return out;
}

// $1,234.56 · -$12 · $-12.5 · +$3.4 (k/M/B-abbreviated amounts are skipped: too lossy to check)
const MONEY = /[-+−]?\s?\$\s?[-−]?\d[\d,]*(?:\.\d+)?(?![\d.]*\s?[kKmMbB]\b)/g;
const PERCENT = /[-+−]?\d+(?:\.\d+)?\s?%/g;
const parse = (s: string) => Math.abs(Number(s.replace(/[^\d.]/g, "")));

/**
 * The $ and % figures in `text` that no tool result supports. A money figure
 * must equal some tool number (to the cent, or to the dollar when written
 * whole). A percentage must equal a tool percentage (`toolPercents`, when
 * given), or a ratio between two `ratioBase` amounts (e.g. "MU is 66% of the
 * open value").
 */
export function unverifiedFigures(
  text: string,
  toolNumbers: number[],
  ratioBase?: number[],
  toolPercents?: number[],
): string[] {
  const abs = [...new Set(toolNumbers.map((n) => Math.abs(n)))];
  const moneyOk = (v: number, whole: boolean) =>
    abs.some((t) => Math.abs(t - v) <= 0.011 || (whole && Math.abs(t - v) < 1));
  // Ratios only between headline amounts: across hundreds of numbers almost
  // any percentage is some ratio, which would verify nothing.
  const amounts = [...new Set((ratioBase ?? toolNumbers).map((n) => Math.abs(n)))].filter((t) => t >= 1).slice(0, 60);
  const pcts = toolPercents ? [...new Set(toolPercents.map((n) => Math.abs(n)))] : abs;
  const pctOk = (v: number) => {
    const tol = Math.max(0.051, v * 0.005);
    if (pcts.some((t) => Math.abs(t - v) <= tol)) return true;
    for (const a of amounts) for (const b of amounts) if (b > 0 && Math.abs((100 * a) / b - v) <= tol) return true;
    return false;
  };
  const bad = new Set<string>();
  for (const m of text.match(MONEY) ?? []) {
    const v = parse(m);
    if (!moneyOk(v, !/\.\d/.test(m))) bad.add(m.trim());
  }
  for (const m of text.match(PERCENT) ?? []) {
    const v = parse(m);
    if (v !== 0 && v !== 100 && !pctOk(v)) bad.add(m.trim());
  }
  return [...bad];
}

/**
 * The amounts a percentage may be a ratio of: the strategy totals and the open
 * positions' cost, value and P&L (each and summed). Kept small on purpose:
 * across every number in a result almost any percentage is some ratio.
 */
export function headlineNumbers(byStrategy: Record<string, unknown>): number[] {
  const totals = (byStrategy.totals ?? {}) as Record<string, unknown>;
  const open = (byStrategy.open_positions ?? []) as OpenPosition[];
  const out = Object.entries(totals)
    .filter(([k, v]) => k.endsWith("_usd") && typeof v === "number")
    .map(([, v]) => v as number);
  for (const f of ["cost_basis_usd", "market_value_usd", "unrealized_pnl_usd"] as const) {
    const vals = open.map((p) => p[f]).filter((v): v is number => typeof v === "number");
    out.push(...vals, vals.reduce((a, v) => a + v, 0));
  }
  return out;
}

// Order matters: the first label that matches the matched phrase wins.
const LABELS: { re: RegExp; field: "realized_pnl_usd" | "unrealized_pnl_usd" | "invested_usd" | "return_pct" | null }[] = [
  // return_pct is the TOTAL return; no tool field is a "realized return" %.
  { re: /^realized returns?$/i, field: null },
  { re: /\bunrealized\b/i, field: "unrealized_pnl_usd" },
  { re: /\brealized\b/i, field: "realized_pnl_usd" },
  { re: /\binvest(?:ed|ment)\b/i, field: "invested_usd" },
  { re: /\breturns?\b/i, field: "return_pct" },
];
const LABEL = "realized returns?|unrealized|realized|invest(?:ed|ment)|returns?";
// A label, then up to 40 chars without another label or number, then the figure.
const LABELLED = new RegExp(
  `\\b(${LABEL})\\b(?:(?!\\b(?:${LABEL})\\b)[^$%\\d]){0,40}?([-+−]?\\s?\\$\\s?[-−]?\\d[\\d,]*(?:\\.\\d+)?|[-+−]?\\d+(?:\\.\\d+)?\\s?%)`,
  "gi",
);

/**
 * Figures whose label contradicts the tool: "realized P&L of $1,046.80" when
 * $1,046.80 is the TOTAL P&L. A labelled figure must equal that field, in the
 * totals or for some symbol (cost basis counts as invested). Only the figure
 * right after a label (within a few words, same clause) is checked.
 */
export function mislabeledFigures(text: string, byStrategy: Record<string, unknown>): string[] {
  const totals = (byStrategy.totals ?? {}) as Record<string, number>;
  const per = [...((byStrategy.bySymbol ?? []) as Record<string, number>[]), ...((byStrategy.open_positions ?? []) as Record<string, number>[])];
  const allowed = (field: string) => {
    const vals = [totals[field], ...per.map((r) => r[field])];
    if (field === "invested_usd") vals.push(...per.map((r) => r.cost_basis_usd));
    if (field === "unrealized_pnl_usd") vals.push(...per.map((r) => r.unrealized_pct));
    return vals.filter((v) => typeof v === "number").map(Math.abs);
  };
  const bad = new Set<string>();
  // Clauses end at a sentence period (not a decimal point), ";" or a newline.
  for (const c of text.split(/(?<!\d)\.|\.(?!\d)|[;\n]/)) {
    for (const m of c.matchAll(LABELLED)) {
    const label = LABELS.find((l) => l.re.test(m[1]))!;
    if (!label.field) {
      bad.add(m[0].trim());
      continue;
    }
    const v = parse(m[2]);
    const isPct = m[2].includes("%");
    // A % next to a $ label is a rate (e.g. "realized gains of 6%") — only
    // "return" is a % field; other labels are checked on $ figures only.
    if (isPct !== (label.field === "return_pct")) {
      if (isPct && label.field !== "unrealized_pnl_usd") bad.add(m[0].trim());
      continue;
    }
    if (!allowed(label.field).some((a) => Math.abs(a - v) <= Math.max(0.011, isPct ? 0.051 : 0))) bad.add(m[0].trim());
    }
  }
  return [...bad];
}

/**
 * Position counts that contradict the tool ("27 open positions" when 3 are
 * open). Only "N positions/holdings" phrasings: other counts are left alone.
 */
export function wrongPositionCounts(text: string, openCount: number): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(/\b(\d+)\s+(?:open\s+|current\s+|active\s+)?(?:positions?|holdings?)\b/gi))
    if (Number(m[1]) !== openCount) bad.add(m[0]);
  return [...bad];
}

/**
 * Drop the lines (bullets, table rows, sentences on their own line) that carry
 * an unverified figure. Returns the cleaned text and how many lines went.
 */
export function dropUnverifiedLines(text: string, bad: string[]): { text: string; dropped: number } {
  if (!bad.length) return { text, dropped: 0 };
  const lines = text.split("\n");
  const kept = lines.filter((l) => !bad.some((b) => l.includes(b)));
  const dropped = lines.length - kept.length;
  // A heading whose whole section went is noise: drop it too.
  const isHeading = (l?: string) => !!l && /^#{1,6} /.test(l);
  const out = kept.filter((l, i) => {
    if (!isHeading(l)) return true;
    const next = kept.slice(i + 1).find((x) => x.trim() !== "");
    return next !== undefined && !isHeading(next);
  });
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}
