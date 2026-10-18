/**
 * Typed decisions from a local DECISION model (laya, an encoder on Ollama's
 * `/v1/systemone`): you name the labels, it scores them — no text, ~35 ms a
 * question, ~1 GB. It is a cheap FIRST tier, never the only judge: callers take
 * a confident answer and send everything else to their existing LLM path.
 *
 * Measured on this machine before wiring (2026-10-18, AIOS-35): area drawers
 * 82% agreement with qwen3:8b, 91% at confidence ≥ 0.5 (57% coverage); the
 * Telegram relevance gate was no better than the base rate, so it stays on qwen.
 *
 * Fail-soft: a missing model or any error returns null and the caller falls
 * back. A missing model is remembered for a few minutes so a box without laya
 * doesn't pay a failed round-trip on every item.
 */
import { recordUsage } from "./model-track";
import type { ModelTrack } from "./provider";

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
export const DECIDE_MODEL = process.env.AIOS_DECIDE_MODEL ?? "laya:421m-typed-decisions-mlx-fp16";
/** Words kept per option description, tried in turn: one question's options
 *  share a 240-token budget (server-enforced), so long label sets get terser. */
const OPTION_WORDS = [40, 16, 8, 4];
const UNAVAILABLE_MS = 5 * 60_000;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** label → description (null = the label is its own description). */
  criteria: Record<string, string | null>;
}

export interface Decision {
  answers: Record<string, ChoiceAnswer>;
  tokensIn: number;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  /** How concentrated the distribution is (0–1) — NOT P(correct). */
  confidence: number;
}

let unavailableUntil = 0;

function clip(criteria: Record<string, string | null>, words: number): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(criteria).map(([k, v]) => [k, v ? v.split(/\s+/).slice(0, words).join(" ") : v]),
  );
}

/**
 * Ask one or more choice questions about `state`. Returns the answers, or null
 * when the decision model can't answer (caller falls back). Descriptions are
 * shortened automatically when they overflow the option budget. With `track`
 * the call gets its own ledger row; a sweep omits it and records one total.
 */
export async function decide(
  state: string,
  questions: Record<string, ChoiceQuestion>,
  track?: ModelTrack,
): Promise<Decision | null> {
  if (Date.now() < unavailableUntil || !state.trim()) return null;
  for (const words of OPTION_WORDS) {
    const body = {
      model: DECIDE_MODEL,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([k, q]) => [k, { ...q, criteria: clip(q.criteria, words) }]),
      ),
      keep_alive: "15m",
    };
    try {
      const res = await fetch(`${OLLAMA_BASE}/v1/systemone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const err = await res.text();
        if (/budget/i.test(err)) continue; // option text too long → shorter descriptions
        // Not pulled, or AIOS_DECIDE_MODEL names a chat model → stop asking for a while.
        if (res.status === 404 || /not found|not a .*decision model/i.test(err)) {
          unavailableUntil = Date.now() + UNAVAILABLE_MS;
        }
        return null;
      }
      const data = (await res.json()) as {
        answers?: Record<string, ChoiceAnswer>;
        usage?: { input_tokens?: number };
      };
      if (!data.answers) return null;
      const tokensIn = data.usage?.input_tokens ?? 0;
      if (track) void recordUsage("ollama", DECIDE_MODEL, track, tokensIn, 0);
      return { answers: data.answers, tokensIn };
    } catch {
      return null;
    }
  }
  return null;
}
