import { DeckGrid, type DeckWidget } from "@/core/ui/DeckGrid";

/**
 * The home page: the tiered widget deck — Now (the day's strip, what needs
 * you, the inbox) → In motion (the work in play). Today and the old /deck were
 * two competing homes; this is the one. The full queue with snooze/approve
 * and the day plan live one click away at /m/today/queue and /m/today/plan.
 */
export async function TodayPage() {
  // Lazy: the registry imports this module's manifest, which imports this page.
  const [{ getServerModules }, { modules }] = await Promise.all([
    import("@/modules/registry.server"),
    import("@/modules/registry"),
  ]);
  const all = getServerModules().flatMap((m) => {
    const accent =
      modules.find((mod) => mod.id === m.id)?.accent ?? "var(--color-ink-faint)";
    return m.widgets.map((w) => ({ w, moduleId: m.id, accent }));
  });
  // Whether a card shows, or shows as its one-line form, is decided per visit.
  const resolved = await Promise.all(
    all.map(async (x) => {
      const [hidden, compact] = await Promise.all([
        x.w.hideWhen?.() ?? false,
        x.w.compact?.when() ?? false,
      ]);
      return { ...x, hidden, compact };
    }),
  );
  const widgets: DeckWidget[] = resolved
    .filter((x) => !x.hidden)
    .map(({ w, moduleId, accent, compact }) => ({
      id: w.id,
      title: w.title,
      moduleId,
      component: w.component,
      priority: w.priority ?? 2,
      span: w.span ?? 1,
      accent,
      href: w.href,
      bare: w.bare,
      compact: compact ? w.compact?.component : undefined,
    }));

  return <DeckGrid widgets={widgets} />;
}
