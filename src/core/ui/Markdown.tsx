"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChartEmbed, SafeImg } from "./ChartEmbed";
import { reflowCollapsedTables } from "./reflowTables";

/** Shared apOS-styled markdown renderer (reports, insights, agent output). */
const components: Components = {
  h1: (props) => (
    <h1
      className="mt-4 mb-2 font-display text-lg font-semibold text-ink first:mt-0"
      {...props}
    />
  ),
  h2: (props) => (
    <h2
      className="mt-4 mb-2 font-display text-base font-semibold text-ink first:mt-0"
      {...props}
    />
  ),
  h3: (props) => (
    <h3
      className="mt-3 mb-1.5 font-display text-sm font-medium text-ink first:mt-0"
      {...props}
    />
  ),
  p: ({ node, children, ...props }) => {
    // remark wraps a standalone image line in a <p>, but our chart <img> renders
    // as a block <div> (ChartEmbed) — illegal inside <p>, which the browser
    // splits, causing a hydration mismatch. Unwrap a paragraph whose only real
    // child is an image so the chart renders as a clean block.
    const kids = (node?.children ?? []).filter(
      (c) => !(c.type === "text" && !c.value.trim()),
    );
    if (kids.length === 1 && kids[0].type === "element" && kids[0].tagName === "img") {
      return <>{children}</>;
    }
    return (
      <p className="mb-2 text-sm leading-relaxed text-ink-dim" {...props}>
        {children}
      </p>
    );
  },
  a: (props) => (
    <a
      className="text-plasma underline decoration-plasma/40 underline-offset-2 transition hover:decoration-plasma"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  strong: (props) => <strong className="font-semibold text-ink" {...props} />,
  em: (props) => <em className="text-ink-dim/90" {...props} />,
  ul: (props) => (
    <ul
      className="mb-2.5 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-dim marker:text-ink-faint"
      {...props}
    />
  ),
  ol: (props) => (
    <ol
      className="mb-2.5 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink-dim marker:text-ink-faint"
      {...props}
    />
  ),
  li: (props) => <li className="pl-0.5" {...props} />,
  code: (props) => (
    <code
      className="rounded bg-white/5 px-1 py-0.5 font-mono text-[12px] text-ion"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="mb-2.5 overflow-x-auto rounded-lg border border-white/6 bg-black/30 p-3 font-mono text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote
      className="mb-2.5 border-l-2 border-violet/40 pl-3 text-sm italic text-ink-dim"
      {...props}
    />
  ),
  hr: () => <hr className="my-3 border-white/6" />,
  // GFM tables — without these the model's `| a | b |` output renders as raw
  // pipes (same fix as the Ask answer view).
  table: (props) => (
    <div className="mb-3 overflow-x-auto rounded-lg border border-white/8">
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  thead: (props) => <thead className="bg-white/[0.04]" {...props} />,
  tr: (props) => <tr {...props} />,
  th: (props) => (
    <th
      className="border-b border-white/10 px-3 py-2 text-left align-top font-mono text-[10px] uppercase tracking-widest text-ink-dim"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="border-b border-white/6 px-3 py-2 align-top leading-relaxed text-ink-dim [&:not(:last-child)]:border-r [&:not(:last-child)]:border-white/6"
      {...props}
    />
  ),
  // Charts (viz.chart) render INTERACTIVELY; other images as a plain <img>.
  img: (props) => {
    const src = String(props.src ?? "");
    if (/^\/api\/charts\/[0-9a-f-]+$/i.test(src)) return <ChartEmbed src={src} />;
    return <SafeImg src={src || undefined} alt={props.alt} />;
  },
};

// A larger-heading variant for full-page reading views (the note view), sharing
// every other element — tables, lists, charts, code — with the chat renderer.
const noteComponents: Components = {
  ...components,
  h1: (props) => (
    <h1
      className="mt-6 mb-3 font-display text-2xl font-semibold text-ink first:mt-0"
      {...props}
    />
  ),
  h2: (props) => (
    <h2
      className="mt-5 mb-2.5 font-display text-xl font-semibold text-ink first:mt-0"
      {...props}
    />
  ),
  h3: (props) => (
    <h3
      className="mt-4 mb-2 font-display text-base font-medium text-ink first:mt-0"
      {...props}
    />
  ),
};

/**
 * Shared apOS markdown renderer — the single source of truth for how the app
 * displays model/report markdown (GFM tables, charts, collapsed-table repair).
 * Use this everywhere markdown is shown so fixes land in one place. `size="note"`
 * switches to the larger reading typography of a full-page note.
 */
export function Markdown({
  children,
  size = "chat",
}: {
  children: string;
  size?: "chat" | "note";
}) {
  return (
    <div dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={size === "note" ? noteComponents : components}
      >
        {reflowCollapsedTables(children)}
      </ReactMarkdown>
    </div>
  );
}
