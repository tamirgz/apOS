import {
  Bell,
  Bot,
  BookOpen,
  Database,
  Filter,
  GitBranch,
  GitMerge,
  LayoutDashboard,
  Repeat,
  Search,
  Split,
  SquareStack,
  UserCheck,
  Users,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { FlowNodeKind } from "@/modules/flows/schema";

/**
 * Presentation + wiring metadata for each node kind the Studio canvas exposes.
 * Colours are fixed hex (theme-independent, applied via inline style like
 * orbit's node colouring) so a node reads the same across the app's themes.
 * `outPorts` describes the source ports a node offers for wiring:
 *   - "single" → one unnamed output (fromPort ""), any number of edges
 *   - "ports"  → one edge target per label in config.ports (branch)
 *   - "none"   → terminal, no outputs (output node)
 */
export interface KindMeta {
  label: string;
  blurb: string;
  color: string;
  Icon: LucideIcon;
  hasInput: boolean;
  outPorts: "single" | "ports" | "none";
  /** Default config.ports for kinds that route on named ports. */
  defaultPorts?: string[];
}

const AGENT = "#8b6dff";
const LOGIC = "#d1a02a";
const OUT = "#16a97a";
const TRIG = "#d98324";
const SUB = "#4aa3c9";
const HUMAN = "#e0708a";
const SOURCE = "#3a9ad9";

export const KIND_META: Record<string, KindMeta> = {
  trigger: {
    label: "Trigger",
    blurb: "Where the flow starts",
    color: TRIG,
    Icon: Zap,
    hasInput: false,
    outPorts: "single",
  },
  source: {
    label: "Source",
    blurb: "Inject data (search / text) as the input",
    color: SOURCE,
    Icon: Database,
    hasInput: false,
    outPorts: "single",
  },
  agent: {
    label: "Agent",
    blurb: "Run an agent on the upstream result",
    color: AGENT,
    Icon: Bot,
    hasInput: true,
    outPorts: "single",
  },
  branch: {
    label: "Branch",
    blurb: "Route on a condition — one path taken",
    color: LOGIC,
    Icon: GitBranch,
    hasInput: true,
    outPorts: "ports",
    defaultPorts: ["yes", "no"],
  },
  filter: {
    label: "Filter",
    blurb: "Pass on a condition, else stop the path",
    color: LOGIC,
    Icon: Filter,
    hasInput: true,
    outPorts: "single",
  },
  fanout: {
    label: "Fan-out",
    blurb: "Run every downstream path in parallel",
    color: LOGIC,
    Icon: Split,
    hasInput: true,
    outPorts: "single",
  },
  merge: {
    label: "Merge",
    blurb: "Join paths — wait, then combine",
    color: LOGIC,
    Icon: GitMerge,
    hasInput: true,
    outPorts: "single",
  },
  loop: {
    label: "Loop",
    blurb: "Run a sub-flow for each item",
    color: LOGIC,
    Icon: Repeat,
    hasInput: true,
    outPorts: "single",
  },
  subroutine: {
    label: "Sub-flow",
    blurb: "Run another flow inline",
    color: SUB,
    Icon: Workflow,
    hasInput: true,
    outPorts: "single",
  },
  human: {
    label: "Human",
    blurb: "Pause for your approval",
    color: HUMAN,
    Icon: UserCheck,
    hasInput: true,
    outPorts: "single",
  },
  tool: {
    label: "Tool / action",
    blurb: "Run one tool directly — no agent",
    color: HUMAN,
    Icon: Wrench,
    hasInput: true,
    outPorts: "single",
  },
  output: {
    label: "Output",
    blurb: "Deliver the result (notify / card / slack)",
    color: OUT,
    Icon: Bell,
    hasInput: true,
    outPorts: "none",
  },
};

/** A palette entry — a node kind plus preset config (e.g. a Source preset that
 *  drops a `source` node already set to search vs. projects). */
export interface PaletteItem {
  key: string;
  label: string;
  blurb: string;
  kind: FlowNodeKind;
  Icon: LucideIcon;
  color: string;
  config?: Record<string, unknown>;
}

/** The palette grouped into the design's sections, in display order. */
export const PALETTE_GROUPS: { label: string; items: PaletteItem[] }[] = [
  {
    label: "Triggers",
    items: [
      { key: "trigger", label: "Trigger", blurb: "Where the flow starts (set schedule / event above)", kind: "trigger", Icon: Zap, color: TRIG },
    ],
  },
  {
    label: "Agents",
    items: [
      { key: "agent", label: "Agent", blurb: "Run an agent on the upstream result", kind: "agent", Icon: Bot, color: AGENT },
      { key: "subroutine", label: "Sub-routine", blurb: "Run another flow inline", kind: "subroutine", Icon: Workflow, color: SUB },
    ],
  },
  {
    label: "Sources",
    items: [
      { key: "src-projects", label: "Projects", blurb: "Your active projects + health", kind: "source", Icon: SquareStack, color: SOURCE, config: { sourceType: "projects" } },
      { key: "src-people", label: "People & meetings", blurb: "People + open follow-ups", kind: "source", Icon: Users, color: SOURCE, config: { sourceType: "people" } },
      { key: "src-knowledge", label: "Knowledge / vault", blurb: "Search notes, knowledge & vault", kind: "source", Icon: BookOpen, color: SOURCE, config: { sourceType: "knowledge" } },
      { key: "src-search", label: "Semantic search", blurb: "Search the whole corpus", kind: "source", Icon: Search, color: SOURCE, config: { sourceType: "search" } },
    ],
  },
  {
    label: "Logic & flow",
    items: [
      { key: "branch", label: "Branch (if)", blurb: "Route on a condition — one path", kind: "branch", Icon: GitBranch, color: LOGIC },
      { key: "filter", label: "Filter", blurb: "Pass on a condition, else stop", kind: "filter", Icon: Filter, color: LOGIC },
      { key: "fanout", label: "Fan-out", blurb: "Run every path in parallel", kind: "fanout", Icon: Split, color: LOGIC },
      { key: "merge", label: "Merge", blurb: "Join paths — wait, then combine", kind: "merge", Icon: GitMerge, color: LOGIC },
      { key: "loop", label: "Loop", blurb: "Run a sub-flow per item", kind: "loop", Icon: Repeat, color: LOGIC },
    ],
  },
  {
    label: "Human & tools",
    items: [
      { key: "human", label: "Human step", blurb: "Pause for your approval", kind: "human", Icon: UserCheck, color: HUMAN },
      { key: "tool", label: "Tool / action", blurb: "Run one tool directly — no agent", kind: "tool", Icon: Wrench, color: HUMAN },
    ],
  },
  {
    label: "Delivery",
    items: [
      { key: "out-card", label: "Needs-you card", blurb: "Raise a card in Needs you", kind: "output", Icon: Bell, color: OUT, config: { tool: "card" } },
      { key: "out-notify", label: "Bell + Slack", blurb: "Notify (mirrored to Slack)", kind: "output", Icon: Bell, color: OUT, config: { tool: "notify" } },
      { key: "out-cockpit", label: "Cockpit brief", blurb: "Post to the dashboard cockpit", kind: "output", Icon: LayoutDashboard, color: OUT, config: { tool: "cockpit" } },
    ],
  },
];

/** Kinds offered in the palette, in display order. */
export const PALETTE_KINDS: FlowNodeKind[] = [
  "trigger",
  "source",
  "agent",
  "branch",
  "filter",
  "fanout",
  "merge",
  "loop",
  "subroutine",
  "human",
  "output",
];

export const metaFor = (kind: string): KindMeta =>
  KIND_META[kind] ?? {
    label: kind,
    blurb: "",
    color: "#8390a6",
    Icon: Zap,
    hasInput: true,
    outPorts: "single",
  };

export const NODE_W = 194;
export const NODE_H = 62;

/** Output ports a node offers, as [label] (label "" = the single unnamed port). */
export function outputPortsOf(kind: string, config?: Record<string, unknown>): string[] {
  const meta = metaFor(kind);
  if (meta.outPorts === "none") return [];
  if (meta.outPorts === "ports") {
    const ports = (config?.ports as string[] | undefined) ?? meta.defaultPorts ?? [];
    return ports.length ? ports : ["out"];
  }
  return [""];
}
