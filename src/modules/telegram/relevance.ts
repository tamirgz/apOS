/**
 * The cheap relevance gate. A small LOCAL model decides whether a post is worth
 * a (potentially expensive) routine run — so the channel's firehose is filtered
 * for ~free before anything costly happens. Which model is configurable via the
 * `source.relevance` route (default: qwen3:8b), so it's never hardwired.
 *
 * Why a small LLM and not embeddings: on an all-cybersecurity channel, embedding
 * similarity can't separate a product's niche (links/phishing/QR/CDR/files) from
 * generic cyber news — everything scores alike. A tiny local model reasons about
 * the niche and does; verified against real posts.
 */
import { db } from "@/core/db/client";

export interface Verdict {
  relevant: boolean;
  why: string;
}

/**
 * The default EXCLUDE list — the "not relevant even if it's cybersecurity"
 * cases that used to be hard-coded in the prompt. Now they seed a new channel's
 * editable exclude list, so the boundary is visible and tunable per channel.
 */
export const DEFAULT_EXCLUDE = [
  "server-side vulnerabilities / CVEs (RCE, SQL-injection, router / VPN / appliance bugs)",
  "OT / ICS (industrial control) attacks",
  "data breaches that don't involve the relevant topics above",
  "company, funding, policy or legal news",
  "hardware or AI-model news",
  "memes, promotions, advertisements",
].join("\n");

/** One topic per line (or ';'-separated), rendered as a clean bullet list. */
function toBullets(text: string): string {
  return text
    .split(/[\n;]+/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join("\n");
}

export async function classifyRelevance(input: {
  text: string;
  linkedText?: string | null;
  /** Relevant topics — one per line (the channel's include list). */
  include: string;
  /** Not-relevant topics, even if cybersecurity — one per line. */
  exclude?: string | null;
}): Promise<Verdict> {
  const { resolveRoute } = await import("@/core/ai/routing");
  const route = await resolveRoute("source.relevance");

  const includeList = toBullets(input.include) || "- (nothing specified)";
  const excludeList = toBullets(input.exclude ?? "");

  const system =
    "You are a strict relevance gate. Classify a post by its CORE SUBJECT only — not by a keyword that merely appears in passing.\n\n" +
    "RELEVANT — mark true ONLY if the post's core subject is one of these:\n" +
    includeList +
    "\n\n" +
    (excludeList
      ? "NOT RELEVANT — mark false if the core subject is one of these, even if it is still cybersecurity:\n" +
        excludeList +
        "\n\n"
      : "") +
    "Also mark false for anything whose core subject is none of the RELEVANT items above.\n" +
    'Reply with ONLY compact JSON: {"relevant": true|false, "why": "<=8 words"}.';

  const body =
    `POST:\n${input.text.slice(0, 1500)}` +
    (input.linkedText ? `\n\nLINKED ARTICLE:\n${input.linkedText.slice(0, 1500)}` : "");

  let out = "";
  try {
    for await (const ev of route.provider.run({
      system,
      // `/no_think` keeps a reasoning model fast for a yes/no; harmless elsewhere.
      messages: [{ role: "user", content: `/no_think\n${body}` }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
      track: { source: "gate", label: "telegram relevance" },
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "done" && ev.text) out = ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  } catch (e) {
    // If the gate can't run, fail OPEN toward review rather than dropping a
    // possibly-important post: mark relevant with the reason, let the human see.
    return { relevant: true, why: `gate error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 60) };
  }

  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Partial<Verdict>;
      return { relevant: !!o.relevant, why: String(o.why ?? "").slice(0, 80) };
    } catch {
      /* fall through */
    }
  }
  // Unparseable → don't silently drop; surface for review.
  return { relevant: true, why: "gate returned no verdict" };
}
