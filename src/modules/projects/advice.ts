// Worker-safe helpers for the advisor's own suggestions (no "use server").

/** A suggestion repeated this long without being acted on is dropped, not re-made. */
export const STALE_ADVICE_DAYS = 7;

const STOP = new Set(
  "about after again their there these this that those today which while with would your from into have will week weeks days write still before more most".split(" "),
);

/** Distinctive words: file names (MILESTONE.md), identifiers (ETHOS-578, #218) and words of 5+ letters. */
function keyTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.split(/[\s,;:()"'“”—–]+/)) {
    const w = raw.replace(/^[^\w#]+|[^\w]+$/g, "");
    if (!w) continue;
    if (/[.\-#]/.test(w) && /[a-z]/i.test(w) && /\w[.\-]\w|#\d/.test(w)) out.add(w.toLowerCase());
    else if (/^[a-z]{5,}$/i.test(w) && !STOP.has(w.toLowerCase())) out.add(w.toLowerCase());
  }
  return out;
}

/**
 * Whether two recommendations are the same move, reworded. A shared file or
 * identifier ("MILESTONE.md", "ETHOS-578") is enough; otherwise half the
 * shorter one's distinctive words must recur. Deterministic on purpose — the
 * advisor paraphrases its own advice every run, so text equality never holds.
 */
export function sameMove(a: string, b: string): boolean {
  const ta = keyTokens(a);
  const tb = keyTokens(b);
  for (const t of ta) if (/[.\-#]/.test(t) && tb.has(t)) return true;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 3) return false;
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / small.size >= 0.5;
}
