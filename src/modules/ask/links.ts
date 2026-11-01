/**
 * Link-quality policy for Ask, shared by the answer verifier and the web-search
 * enricher so the two never drift. Enrichment links must clear a professional
 * bar: reachable AND free-to-read AND a primary/authoritative source — not a
 * paywall and not a tertiary/crowd/SEO page.
 *
 * `verifyExternalLinks` goes further than a status check: it FETCHES each link,
 * rejects parked/for-sale/404 pages by content signature, and runs a local-LLM
 * judge over the real page text to confirm it's genuinely on-topic — because a
 * status-200 check alone lets a parked domain (GoDaddy "for sale"), a soft-404,
 * or a live-but-irrelevant authoritative page through.
 */
import { completeText } from "@/core/ai/routing";
import { fetchUrlText } from "@/modules/telegram/fetch";

/** Domains that return 200 but wall their content behind a login/subscription. */
export const GATED_DOMAIN =
  /(^|\.)(gartner|forrester|idc|statista|wsj|ft|bloomberg|nytimes|economist|hbr|nature|sciencedirect|springer|ieee|academia)\.(com|org|net|edu)$/i;

/**
 * Crowd-sourced, blog, forum and SEO domains — reachable, but not the
 * primary/authoritative sources a professional answer should cite. Demoted just
 * like paywalls: Wikipedia et al. are tertiary references. Enrichment should
 * point at standards bodies, official docs and government/vendor primary sources.
 */
export const LOW_AUTHORITY_DOMAIN =
  /(^|\.)(wikipedia|wikimedia|wiktionary|medium|substack|blogspot|wordpress|quora|reddit|stackoverflow|stackexchange|geeksforgeeks|w3schools|tutorialspoint|javatpoint|baeldung|dev\.to|hackernoon|freecodecamp|simplilearn|guru99|educative|programiz|towardsdatascience|merriam-webster|thesaurus|collinsdictionary|vocabulary|thefreedictionary|yourdictionary|wordnik|urbandictionary|dictionary)\.(com|org|net|io)$/i;

/** Dictionary/reference hosts on any subdomain (e.g. dictionary.cambridge.org). */
const REFERENCE_HOST = /(^|\.)(dictionary|thesaurus)\./i;

/**
 * Cheap, no-network verdict: is this URL unfit to cite as enrichment? True for
 * a bad protocol, a paywalled domain, or a tertiary/crowd source. Used to
 * pre-filter search results before spending a fetch on them.
 */
export function isLowQualityUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  return (
    GATED_DOMAIN.test(u.hostname) ||
    LOW_AUTHORITY_DOMAIN.test(u.hostname) ||
    REFERENCE_HOST.test(u.hostname)
  );
}

/**
 * Parking / for-sale / suspended / soft-404 signatures in a page's fetched text.
 * These pages return HTTP 200, so only their CONTENT gives them away.
 */
const DEAD_PAGE =
  /(this domain (is|may be|might be) (for sale|available)|buy this domain|domain( name)? (is )?for sale|godaddy|sedo(parking)?|afternic|hugedomains|dan\.com|parkingcrew|bodis|website is parked|domain( is)? parked|under construction|coming soon|account (has been )?suspended|page (you requested )?(was )?not found|404\b[^0-9]{0,20}(not found|error)|the requested (page|url|document)[^.]{0,40}(not|could not) (be )?found|no longer (exists|available)|this page (does not|doesn't) exist)/i;


/** Fetch a page's readable text for verification; "" on any failure. */
async function fetchForVerify(url: string): Promise<string> {
  try {
    const t = await fetchUrlText(url);
    return typeof t === "string" ? t.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Batched local-LLM relevance judge: given the question and the real fetched
 * text of each candidate link, return url → keep?. One Ollama call for the whole
 * set — Ollama serves one model at a time, so batching keeps this to a single
 * ~few-second call regardless of link count. Fail-closed: any parse/network
 * trouble drops the link rather than risk citing junk.
 */
async function judgeLinks(
  query: string,
  items: { url: string; text: string }[],
): Promise<Map<string, boolean>> {
  const verdict = new Map<string, boolean>(items.map((it) => [it.url, false]));
  if (items.length === 0) return verdict;
  const list = items
    .map((it, i) => `[${i}] URL: ${it.url}\n${it.text.replace(/\s+/g, " ").slice(0, 900)}`)
    .join("\n\n");
  const system =
    'You verify web links for a research answer. For each numbered page you get its URL and the actual text fetched from it. Mark a page "yes" ONLY if BOTH hold: (1) it is a REAL, live, publicly-readable page (not a domain-for-sale/parking page, not an error/404, not a login/subscribe wall, not empty/placeholder), AND (2) its content substantively covers the SPECIFIC topic asked about — not merely the broader field. Example: if the topic is "XDR", a general cybersecurity-framework page that never actually discusses XDR is "no". When in doubt, answer "no". Reply with ONLY a JSON object mapping each index to "yes" or "no" — no prose.';
  const user = `USER TOPIC: ${query}\n\nPAGES:\n${list}\n\nReply with JSON like {"0":"yes","1":"no"}`;
  try {
    const raw = await completeText("ask.linkJudge", {
      system,
      user,
      label: "ask link judge",
      source: "ask",
      signal: AbortSignal.timeout(60_000),
    });
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const map = JSON.parse(json) as Record<string, string>;
    items.forEach((it, i) => {
      const v = String(map[i] ?? map[String(i)] ?? "").toLowerCase();
      verdict.set(it.url, v.startsWith("y"));
    });
  } catch {
    // fail-closed — leave everything as false
  }
  return verdict;
}

/**
 * Verify every external markdown link in the answer and DEMOTE the ones that
 * aren't real, usable, on-topic resources to plain text (keeping the label). A
 * link survives only if it clears all three checks: the cheap domain gate, a
 * parked/for-sale/404 content signature over its FETCHED text, and a local-LLM
 * relevance judge against the question. The `[n]` citations (no `(url)`) are
 * untouched. Fail-closed throughout — a link we can't confirm is stripped.
 */
export async function verifyExternalLinks(answer: string, query = ""): Promise<string> {
  const linkRe = /\[([^\]]+)\]\(((?:https?:)?\/\/[^)\s]+)\)/gi;
  const urls = [...new Set([...answer.matchAll(linkRe)].map((m) => m[2]))];
  if (urls.length === 0) return answer;

  // Cheap domain gate + fetch content + parked/404 signature (concurrent network).
  const candidates: { url: string; text: string }[] = [];
  const rejected = new Set<string>();
  await Promise.all(
    urls.map(async (u) => {
      if (isLowQualityUrl(u)) {
        rejected.add(u);
        return;
      }
      const text = await fetchForVerify(u);
      if (text.length < 120 || DEAD_PAGE.test(text.slice(0, 3000))) {
        rejected.add(u);
        return;
      }
      candidates.push({ url: u, text });
    }),
  );

  // One local-LLM judge over everything that survived the cheap checks.
  const verdict = await judgeLinks(query, candidates);
  const keep = (u: string) => !rejected.has(u) && verdict.get(u) === true;
  return answer.replace(linkRe, (whole, label, url) => (keep(url) ? whole : label));
}
