import { Suspense, type ComponentType } from "react";
import { cn } from "./cn";
import { WidgetFrame } from "./WidgetFrame";

export type DeckWidget = {
  id: string;
  title: string;
  moduleId: string;
  component: ComponentType;
  priority: 1 | 2;
  span: number;
  accent: string;
  href?: string;
  /** Draws its own chrome: no frame, full width at the top of its tier. */
  bare?: boolean;
  /** Set when the widget's compact form applies right now: shown as a slim line instead of the card. */
  compact?: ComponentType;
};

// Column span / count → static class (Tailwind can't see interpolated class names).
const SPAN_CLASS: Record<number, string> = {
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};
const COLS_CLASS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
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

function BarePending() {
  return <div className="glass h-44 animate-pulse rounded-(--radius-panel)" aria-hidden />;
}

/**
 * The tiered widget grid (the home page's layout): Now → In motion. On large
 * screens it is height-locked to the viewport (minus the top bar) and the
 * tiers flex to fill it, so everything fits on one screen; cards that
 * overflow scroll internally. Small screens fall back to block flow.
 */
export function DeckGrid({ widgets }: { widgets: DeckWidget[] }) {
  const t1bare = widgets.filter((w) => w.priority === 1 && w.bare);
  // Wider cards lead the row.
  const t1hero = widgets.filter((w) => w.priority === 1 && !w.bare).sort((a, b) => b.span - a.span);
  const t2cards = widgets.filter((w) => w.priority === 2 && !w.compact);
  const t2lines = widgets.filter((w) => w.priority === 2 && w.compact);
  const t2cols = Math.min(4, t2cards.length + (t2lines.length ? 1 : 0));

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
      {/* TIER 1 — Now: where the day stands, then what needs you. */}
      <section className="flex flex-col gap-2.5 lg:min-h-0 lg:flex-[1.6]">
        <TierLabel>Now</TierLabel>
        {t1bare.map((w) => {
          const Widget = w.component;
          return (
            <div key={`${w.moduleId}:${w.id}`} className="lg:flex-none">
              <Suspense fallback={<BarePending />}>
                <Widget />
              </Suspense>
            </div>
          );
        })}
        {t1hero.length > 0 && (
          <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:auto-rows-fr lg:grid-cols-5">
            {t1hero.map((w) => frame(w, `${SPAN_CLASS[w.span] ?? ""} min-h-[13rem] lg:min-h-0`))}
          </div>
        )}
      </section>

      {/* TIER 2 — In motion: active work & automation, glanceable. */}
      {t2cols > 0 && (
        <section className="flex flex-col gap-2.5 lg:min-h-0 lg:flex-1">
          <TierLabel>In motion</TierLabel>
          <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:auto-rows-fr", COLS_CLASS[t2cols])}>
            {t2cards.map((w) => frame(w, "min-h-[11rem] lg:min-h-0"))}
            {t2lines.length > 0 && (
              <div className="flex flex-col gap-3">
                {t2lines.map((w) => {
                  const Line = w.compact!;
                  return (
                    <div key={`${w.moduleId}:${w.id}`} className="glass rounded-(--radius-panel) px-4 py-2.5">
                      <Suspense fallback={<div className="h-5 animate-pulse rounded bg-ink/[0.06]" aria-hidden />}>
                        <Line />
                      </Suspense>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
