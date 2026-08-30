/**
 * Shared time formatting — the single source of truth for "N ago" labels and
 * date rendering. Six modules each carried their own copy with drifting
 * behavior ("56s ago" vs "just now", "5m" vs "5m ago", en-US vs en-GB);
 * fixes and wording now land in one place.
 */

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** "just now" / "5m ago" / "3h ago" / "4d ago" / "2mo ago". `compact` drops the " ago". */
export function timeAgo(
  d: Date | string | number | null | undefined,
  opts: { compact?: boolean } = {},
): string {
  if (d == null) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  const suffix = opts.compact ? "" : " ago";
  if (s < MIN) return opts.compact ? "now" : "just now";
  if (s < HOUR) return `${Math.floor(s / MIN)}m${suffix}`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h${suffix}`;
  if (s < 30 * DAY) return `${Math.floor(s / DAY)}d${suffix}`;
  return `${Math.floor(s / (30 * DAY))}mo${suffix}`;
}

/** Day-granular: "today" / "yesterday" / "12d ago" / "3mo ago". */
export function dayAgo(d: Date | string | null | undefined): string {
  if (d == null) return "—";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / (DAY * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** "active today" / "active yesterday" / "active 12d ago" / "no activity". */
export function lastActiveLabel(d: Date | string | null | undefined): string {
  if (d == null) return "no activity";
  return `active ${dayAgo(d)}`;
}

/** Locale-default short date ("Aug 30"). One convention instead of four. */
export function shortDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
