/**
 * Display-only cleanup of people names. The stored name is left untouched:
 * calendar/Gmail hand us quoted names, "Name <email>", "Last, First", bare
 * handles ("naor.penso") or nothing at all — this renders a readable name.
 */

const cap = (w: string) => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w);

/** "gadi.fisher" / "michaely7" → "Gadi Fisher" / "Michaely". */
function fromHandle(handle: string): string {
  const words = handle
    .replace(/\d+/g, " ")
    .split(/[._\-+\s]+/)
    .filter(Boolean)
    .map(cap);
  return words.join(" ") || handle;
}

export function displayName(p: { name: string | null; email: string }): string {
  let n = (p.name ?? "").trim();
  n = n.replace(/^(['"])(.*)\1$/, "$2").trim(); // 'Rani Gavrieli' → Rani Gavrieli
  n = n.replace(/\s*<[^>]*>\s*$/, "").trim(); // Eyal gr <eyal.gr@…> → Eyal gr
  const local = p.email.split("@")[0] ?? p.email;
  if (!n || n.toLowerCase() === p.email.toLowerCase()) return fromHandle(local);
  const lastFirst = n.match(/^([^,\s]+),\s*([^,]+)$/); // Snir, Yair → Yair Snir
  if (lastFirst) return `${lastFirst[2].trim()} ${lastFirst[1]}`;
  // A single token that is really a handle (has . or _) → split it.
  if (!/\s/.test(n) && /[._]/.test(n)) return fromHandle(n);
  if (!/\s/.test(n) && n === n.toLowerCase()) return cap(n); // roy → Roy
  return n;
}

/**
 * Not a person: calendar group/resource addresses ("System") and automated
 * senders. Hidden from the People list, not deleted.
 */
export function isSystemContact(p: { name: string | null; email: string }): boolean {
  const e = p.email.toLowerCase();
  if (/@(group|resource|import)\.calendar\.google\.com$/.test(e)) return true;
  if (/^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|calendar-notification)\b/.test(e)) return true;
  return (p.name ?? "").trim().toLowerCase() === "system";
}
