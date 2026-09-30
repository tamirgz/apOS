import { Suspense, type ComponentType } from "react";
import { WidgetFrame } from "./WidgetFrame";

export type DeckWidget = {
  id: string;
  title: string;
  moduleId: string;
  component: ComponentType;
  stat?: ComponentType;
  priority: 1 | 2 | 3;
  span: number;
  accent: string;
  href?: string;
};

// Column span → static class (Tailwind can't see interpolated class names).
const SPAN_CLASS: Record<number, string> = {
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};

function TierLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-ink-faint">
        {children}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-white/8 to-transparent" />
    </div>
  );
}

/**
 * Each widget queries on its own; without a boundary apiece the whole deck
 * waited for the slowest one. Now the frames paint at once and every widget
 * streams in as soon as its own data is back.
 */
function WidgetPending() {
  return (
    <div className="flex animate-pulse flex-col gap-2 pt-1" aria-hidden>
      <div className="h-3 w-3/4 rounded bg-ink/[0.06]" />
      <div className="h-3 w-1/2 rounded bg-ink/[0.06]" />
      <div className="h-3 w-2/3 rounded bg-ink/[0.06]" />
    </div>
  );
}

function StatPending() {
  return (
    <div className="flex animate-pulse flex-col gap-2 px-4 py-3" aria-hidden>
      <div className="h-2.5 w-16 rounded bg-ink/[0.06]" />
      <div className="h-5 w-10 rounded bg-ink/[0.06]" />
    </div>
  );
}

/**
 * The tiered widget grid (the home page's layout): Now → In motion → At a
 * glance. On large screens it is height-locked to the viewport (minus the top
 * bar) and the tiers flex to fill it, so everything fits on one screen; cards
 * that overflow scroll internally. Small screens fall back to block flow.
 */
export function DeckGrid({ widgets }: { widgets: DeckWidget[] }) {
  const t1hero = widgets.filter((w) => w.priority === 1 && w.span < 4);
  const t1wide = widgets.filter((w) => w.priority === 1 && w.span >= 4);
  const tier2 = widgets.filter((w) => w.priority === 2);
  const tier3 = widgets.filter((w) => w.priority === 3);

  let idx = 0;
  const frame = (w: DeckWidget, extra: string) => {
    const Widget = w.component;
    return (
      <WidgetFrame
        key={`${w.moduleId}:${w.id}`}
        index={idx++}
        accent={w.accent}
        title={w.title}
        href={w.href ?? `/m/${w.moduleId}`}
        className={extra}
      >
        <Suspense fallback={<WidgetPending />}>
          <Widget />
        </Suspense>
      </WidgetFrame>
    );
  };

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-5rem)] lg:gap-3.5">
      {/* TIER 1 — Now: what needs you, today's agenda, the work in play. */}
      <section className="flex flex-col gap-2.5 lg:min-h-0 lg:flex-[1.45]">
        <TierLabel>Now</TierLabel>
        <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:auto-rows-fr lg:grid-cols-4">
          {t1hero.map((w) =>
            frame(w, `${SPAN_CLASS[w.span] ?? ""} min-h-[13rem] lg:min-h-0`),
          )}
        </div>
        {t1wide.map((w) => (
          <div key={`${w.moduleId}:${w.id}`} className="lg:flex-none">
            {frame(w, "min-h-[7rem] lg:h-[6.75rem]")}
          </div>
        ))}
      </section>

      {/* TIER 2 — In motion: active work & automation, glanceable. */}
      {tier2.length > 0 && (
        <section className="flex flex-col gap-2.5 lg:min-h-0 lg:flex-1">
          <TierLabel>In motion</TierLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:auto-rows-fr lg:grid-cols-4">
            {tier2.map((w) => frame(w, "min-h-[11rem] lg:min-h-0"))}
          </div>
        </section>
      )}

      {/* TIER 3 — Ambient: passive counts, one slim pulse strip. */}
      {tier3.length > 0 && (
        <section className="flex flex-col gap-2.5 lg:flex-none">
          <TierLabel>At a glance</TierLabel>
          <div className="glass grid grid-cols-2 divide-x divide-y divide-white/5 overflow-hidden rounded-(--radius-panel) sm:grid-cols-4 sm:divide-y-0">
            {tier3.map((w) => {
              const Stat = w.stat ?? w.component;
              return (
                <Suspense key={`${w.moduleId}:${w.id}`} fallback={<StatPending />}>
                  <Stat />
                </Suspense>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
