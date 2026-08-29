import type { FlowGraph } from "@/modules/flows/schema";

/**
 * Built-in starter flows. Instantiating one creates a new flow with this graph;
 * agent nodes come blank (no agentId) so you pick the agent after dropping it in.
 * Server-only data — the client gets just the display cards (templateCards()).
 */
export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  graph: FlowGraph;
}

const agent = (id: string, name: string, x: number, y: number) => ({ id, kind: "agent" as const, name, x, y, config: {} });
const out = (id: string, x: number, y: number, name = "Notify") => ({ id, kind: "output" as const, name, x, y, config: { tool: "notify" } });
const trigger = (x: number, y: number) => ({ id: "t", kind: "trigger" as const, name: "Start", x, y });

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "review-ship",
    name: "Draft → Review → Ship",
    description: "An agent drafts, you approve at a human gate, then it's delivered.",
    graph: {
      nodes: [
        trigger(90, 180),
        agent("draft", "Draft", 330, 180),
        { id: "gate", kind: "human", name: "Approve", x: 570, y: 180, config: { prompt: "Approve the draft to ship it?" } },
        out("done", 810, 180),
      ],
      edges: [
        { id: "e1", from: "t", to: "draft" },
        { id: "e2", from: "draft", to: "gate" },
        { id: "e3", from: "gate", to: "done" },
      ],
    },
  },
  {
    id: "research-fanout",
    name: "Research fan-out → merge",
    description: "Scout the topic, explore two angles in parallel, then synthesize.",
    graph: {
      nodes: [
        trigger(70, 210),
        agent("scout", "Scout", 290, 210),
        { id: "fan", kind: "fanout", name: "Split", x: 510, y: 210, config: {} },
        agent("a", "Angle A", 720, 110),
        agent("b", "Angle B", 720, 310),
        { id: "merge", kind: "merge", name: "Join", x: 940, y: 210, config: {} },
        agent("synth", "Synthesize", 1160, 210),
        out("done", 1400, 210),
      ],
      edges: [
        { id: "e1", from: "t", to: "scout" },
        { id: "e2", from: "scout", to: "fan" },
        { id: "e3", from: "fan", to: "a" },
        { id: "e4", from: "fan", to: "b" },
        { id: "e5", from: "a", to: "merge" },
        { id: "e6", from: "b", to: "merge" },
        { id: "e7", from: "merge", to: "synth" },
        { id: "e8", from: "synth", to: "done" },
      ],
    },
  },
  {
    id: "route-on-result",
    name: "Route on result",
    description: "Assess, then branch: escalate to another agent, or just log it.",
    graph: {
      nodes: [
        trigger(70, 190),
        agent("assess", "Assess", 300, 190),
        {
          id: "branch",
          kind: "branch",
          name: "Escalate?",
          x: 540,
          y: 190,
          config: { ports: ["escalate", "ignore"], condition: "decision == escalate" },
        },
        agent("handle", "Handle", 800, 110),
        out("log", 800, 280, "Log"),
      ],
      edges: [
        { id: "e1", from: "t", to: "assess" },
        { id: "e2", from: "assess", to: "branch" },
        { id: "e3", from: "branch", fromPort: "escalate", to: "handle" },
        { id: "e4", from: "branch", fromPort: "ignore", to: "log" },
      ],
    },
  },
  {
    id: "scheduled-digest",
    name: "Scheduled digest",
    description: "One agent, on a cron — arm a schedule and it runs itself.",
    graph: {
      nodes: [trigger(90, 180), agent("digest", "Digest", 340, 180), out("done", 590, 180)],
      edges: [
        { id: "e1", from: "t", to: "digest" },
        { id: "e2", from: "digest", to: "done" },
      ],
    },
  },
];

export interface TemplateCard {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  agentCount: number;
}

/** Client-safe display metadata for the gallery (no graphs shipped to the browser). */
export function templateCards(): TemplateCard[] {
  return FLOW_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    nodeCount: t.graph.nodes.length,
    agentCount: t.graph.nodes.filter((n) => n.kind === "agent").length,
  }));
}

export const templateById = (id: string): FlowTemplate | undefined =>
  FLOW_TEMPLATES.find((t) => t.id === id);
