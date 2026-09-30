import { DeckGrid, type DeckWidget } from "@/core/ui/DeckGrid";

/**
 * The home page: the tiered widget deck — Now (needs you, agenda, the work in
 * play) → In motion → At a glance. Today and the old /deck were two competing
 * homes; this is the one. The full queue with snooze/approve and the day plan
 * live one click away at /m/today/queue.
 */
export async function TodayPage() {
  // Lazy: the registry imports this module's manifest, which imports this page.
  const [{ serverModules }, { modules }] = await Promise.all([
    import("@/modules/registry.server"),
    import("@/modules/registry"),
  ]);
  const widgets: DeckWidget[] = serverModules.flatMap((m) => {
    const accent =
      modules.find((mod) => mod.id === m.id)?.accent ?? "var(--color-ink-faint)";
    return m.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      moduleId: m.id,
      component: w.component,
      stat: w.stat,
      priority: w.priority ?? 2,
      span: w.span ?? 1,
      accent,
      href: w.href,
    }));
  });

  return <DeckGrid widgets={widgets} />;
}
