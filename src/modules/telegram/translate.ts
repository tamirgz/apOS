/**
 * Cross-lingual bridge for search. The unified search_index embeds with
 * nomic-embed-text, whose vectors CLUSTER BY LANGUAGE — so a Russian or Hebrew
 * post never surfaces for an English query. We translate a foreign post to
 * English once (a small LOCAL model, free) and embed that gloss, so an English
 * semantic search retrieves the original foreign post. English posts are left
 * untouched (needsTranslation → false).
 */
import { db } from "@/core/db/client";

/** Does this text contain enough non-Latin script (Cyrillic / Hebrew / Arabic /
 *  Greek) to be worth translating? Cheap char-class heuristic, no model call. */
export function needsTranslation(text: string): boolean {
  if (!text) return false;
  const foreign = (text.match(/[Ѐ-ӿ֐-׿؀-ۿͰ-Ͽ]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  // Foreign script clearly present and not dwarfed by Latin (URLs, hashtags).
  return foreign >= 8 && foreign > latin * 0.5;
}

/** Translate a foreign-language post to English (gist is enough for search).
 *  Returns null on any failure — the caller then embeds the original text. */
export async function translateToEnglish(text: string): Promise<string | null> {
  const src = text.trim();
  if (!src) return null;
  try {
    const { resolveRoute } = await import("@/core/ai/routing");
    const route = await resolveRoute("source.relevance"); // local, free
    const system =
      "You are a translation engine. Translate the user's text to English. " +
      "Output ONLY the English translation — no preamble, no notes, no quotes. " +
      "Keep proper nouns, product names, tickers and hashtags as-is.";
    let out = "";
    for await (const ev of route.provider.run({
      system,
      messages: [{ role: "user", content: `/no_think\n${src.slice(0, 2000)}` }],
      tools: [],
      toolCtx: { db },
      model: route.model,
      maxTurns: 1,
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "done" && ev.text) out = ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
    const clean = out
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^\s*(translation|english)\s*:\s*/i, "")
      .trim();
    return clean || null;
  } catch {
    return null;
  }
}
