import {
  Bell,
  Bot,
  Filter,
  GitBranch,
  GitMerge,
  Repeat,
  Split,
  Workflow,
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

export const KIND_META: Record<string, KindMeta> = {
  trigger: {
    label: "Trigger",
    blurb: "Where the flow starts",
    color: TRIG,
    Icon: Zap,
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
  output: {
    label: "Output",
    blurb: "Deliver the result (notify)",
    color: OUT,
    Icon: Bell,
    hasInput: true,
    outPorts: "none",
  },
};

/** Kinds offered in the palette, in display order. */
export const PALETTE_KINDS: FlowNodeKind[] = [
  "trigger",
  "agent",
  "branch",
  "filter",
  "fanout",
  "merge",
  "loop",
  "subroutine",
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
