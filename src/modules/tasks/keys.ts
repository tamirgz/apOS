/**
 * Work-item identifiers — pure, client-safe helpers.
 *
 *   project item → "<PROJECT KEY>-<number>"  e.g. ETHOS-12, GL-3
 *   unfiled item → "T-<number>"
 *
 * Keys are 2–5 uppercase ASCII letters so "KEY-N" is easy to type in a commit
 * message and to match with IDENTIFIER_RE (the repo watcher links commits by it).
 */

export const LOOSE_KEY = "T";
export const LOOSE_SCOPE = "loose";
export const IDENTIFIER_RE = /\b([A-Z]{1,5})-(\d{1,6})\b/g;

/** Split "AeroMantis", "AI Coefficients", "iSentry" into ASCII word parts. */
function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
}

/**
 * Candidate keys for a project name, best first. Multi-word names prefer
 * initials (GitLocker → GL), a short single word is used whole (AIOS, ETHOS),
 * a long one is cut to 3 letters (Ripple → RIP). Names with no Latin letters
 * (Hebrew) get none — the caller falls back to PA, PB, …
 */
export function keyCandidates(name: string): string[] {
  const parts = words(name);
  if (!parts.length) return [];
  const out: string[] = [];
  const whole = parts.join("").toUpperCase();
  if (parts.length > 1) {
    out.push(parts.map((w) => w[0]).join("").toUpperCase().slice(0, 5));
    out.push((parts[0].slice(0, 2) + parts.slice(1).map((w) => w[0]).join("")).toUpperCase().slice(0, 5));
  }
  if (parts.length === 1 && whole.length <= 5) out.push(whole);
  out.push(whole.slice(0, 3), whole.slice(0, 4), whole.slice(0, 5));
  return [...new Set(out.filter((k) => k.length >= 2 && k !== LOOSE_KEY))];
}

/** Pick the first candidate not in `taken`, then letter-suffixed fallbacks. */
export function deriveKey(name: string, taken: Set<string>): string {
  const cands = keyCandidates(name);
  for (const k of cands) if (!taken.has(k)) return k;
  const base = (cands[0] ?? "P").slice(0, 4);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const k = `${base}${c}`.slice(0, 5);
    if (!taken.has(k)) return k;
  }
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(`P${a}${b}`)) return `P${a}${b}`;
  throw new Error("no free project key");
}

/** Validate a user-typed key. Returns the normalized key or null. */
export function normalizeKey(input: string): string | null {
  const k = input.trim().toUpperCase();
  return /^[A-Z]{2,5}$/.test(k) && k !== LOOSE_KEY ? k : null;
}

export function formatIdentifier(key: string | null | undefined, number: number | null | undefined): string | null {
  if (number == null) return null;
  return `${key ?? LOOSE_KEY}-${number}`;
}

export function parseIdentifier(s: string): { key: string; number: number } | null {
  const m = s.trim().toUpperCase().match(/^([A-Z]{1,5})-(\d{1,6})$/);
  return m ? { key: m[1], number: Number(m[2]) } : null;
}
