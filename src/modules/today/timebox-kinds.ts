import type { TimeboxKind } from "./schema";

/** How each box kind looks on the Plan screen — close to its Google colour. */
export const KIND_META: Record<TimeboxKind, { label: string; color: string }> = {
  deep: { label: "Deep", color: "var(--color-violet)" },
  shallow: { label: "Shallow", color: "var(--color-ion)" },
  admin: { label: "Admin", color: "var(--color-ink-dim)" },
  inbox: { label: "Inbox", color: "var(--color-gold)" },
  personal: { label: "Personal", color: "var(--color-plasma)" },
};
