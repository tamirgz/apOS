import { getSetting } from "@/core/app-settings";
import type { AIProviderId } from "@/core/db/schema/ai-routes";

/**
 * What a generation cost, for the usage ledger. USD per 1M tokens.
 *
 * Zero by rule: local runtimes (ollama, mlx), any `:free` model, the NVIDIA tier
 * (the agent layer refuses a model that isn't confirmed $0) and Anthropic (the
 * Claude Max subscription — apOS never uses a metered Anthropic key, see auth.ts).
 *
 * Metered prices come from the gateways' own catalogs, so they track price
 * changes without a hand-kept table: OpenRouter's public /models (per-token
 * strings), Token Harbor's /models (per-1M numbers), and Gemini priced as
 * OpenRouter's `google/<model>`. A model in neither is `null` — unknown, never
 * guessed as $0. OpenRouter's time-of-day `overrides` are ignored: the base
 * price is the list price.
 */
export interface Price {
  in: number;
  out: number;
}

const ZERO: Price = { in: 0, out: 0 };
const ZERO_PROVIDERS = new Set<string>(["ollama", "mlx", "nvidia", "anthropic"]);
const CATALOG_TTL_MS = 24 * 3600_000;

type Catalog = Map<string, Price>;
const catalogs = new Map<string, { at: number; prices: Catalog }>();
const inflight = new Map<string, Promise<Catalog>>();

async function fetchOpenRouter(): Promise<Catalog> {
  const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`openrouter /models ${res.status}`);
  const data = (await res.json()) as {
    data?: { id: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const out: Catalog = new Map();
  for (const m of data.data ?? []) {
    const pin = Number(m.pricing?.prompt);
    const pout = Number(m.pricing?.completion);
    if (Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout >= 0)
      out.set(m.id, { in: pin * 1e6, out: pout * 1e6 });
  }
  return out;
}

async function fetchTokenHarbor(): Promise<Catalog> {
  const base = process.env.TOKENHARBOR_BASE_URL ?? "https://tokenharbor.ai/v1";
  const key =
    (await getSetting("tokenharbor_api_key").catch(() => null))?.trim() ||
    process.env.TOKENHARBOR_API_KEY?.trim();
  const res = await fetch(`${base}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`tokenharbor /models ${res.status}`);
  const data = (await res.json()) as {
    data?: { id: string; pricing?: { input_usd_per_1m?: number; output_usd_per_1m?: number } }[];
  };
  const out: Catalog = new Map();
  for (const m of data.data ?? []) {
    const pin = m.pricing?.input_usd_per_1m;
    const pout = m.pricing?.output_usd_per_1m;
    if (typeof pin === "number" && typeof pout === "number") out.set(m.id, { in: pin, out: pout });
  }
  return out;
}

const FETCHERS: Record<string, () => Promise<Catalog>> = {
  openrouter: fetchOpenRouter,
  tokenharbor: fetchTokenHarbor,
};

/** A gateway's catalog, cached for a day; a failed refresh keeps the stale one. */
async function catalog(gateway: string): Promise<Catalog> {
  const hit = catalogs.get(gateway);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.prices;
  let p = inflight.get(gateway);
  if (!p) {
    p = FETCHERS[gateway]()
      .then((prices) => {
        catalogs.set(gateway, { at: Date.now(), prices });
        return prices;
      })
      .catch(() => hit?.prices ?? new Map())
      .finally(() => inflight.delete(gateway));
    inflight.set(gateway, p);
  }
  return p;
}

/** Price of a model on a provider; null = metered but not in any catalog. */
export async function priceFor(provider: AIProviderId | string, model: string): Promise<Price | null> {
  if (ZERO_PROVIDERS.has(provider) || model.endsWith(":free")) return ZERO;
  if (provider === "openrouter" || provider === "tokenharbor")
    return (await catalog(provider)).get(model) ?? null;
  if (provider === "gemini")
    return (await catalog("openrouter")).get(`google/${model.replace(/^models\//, "")}`) ?? null;
  return null;
}

export const costOf = (p: Price | null, tokensIn: number, tokensOut: number): number | null =>
  p ? (tokensIn * p.in + tokensOut * p.out) / 1e6 : null;
