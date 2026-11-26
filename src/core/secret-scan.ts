/**
 * A cheap shape check for credentials in text about to be stored (AIOS-53 R7:
 * memory never holds a secret). Returns what it matched, by name only — never
 * the value — or null. False positives are fine: the writer rephrases.
 */
const PATTERNS: [string, RegExp][] = [
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style API key", /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{32,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe key", /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/],
  ["private key block", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{30,}=*/i],
  ["connection string with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s/]+/i],
  ["password assignment", /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i],
];

export function scanForSecrets(text: string): string | null {
  for (const [name, re] of PATTERNS) if (re.test(text)) return name;
  return null;
}
