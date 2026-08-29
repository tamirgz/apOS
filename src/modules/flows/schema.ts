import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Flows — visual multi-agent procedures. A flow is a graph of NODES wired by
 * EDGES; the Flow Engine (worker) walks it, running each node and passing one
 * node's output into the next. Agent nodes run as real agent_runs, so a flow is
 * pure ORCHESTRATION over primitives that already exist — see the build plan.
 * The engine is a dataflow scheduler: branch routes on a condition (one port),
 * fan-out runs downstream branches in parallel, merge is a join barrier, filter
 * drops downstream. human / loop / sub-routine land in later phases.
 */
export const FLOW_RUN_STATUSES = [
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
] as const;
export const NODE_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  // A human node waiting on an Approve/Reject decision (run is "paused" too).
  "paused",
] as const;
export const FLOW_NODE_KINDS = [
  "trigger",
  "agent",
  "source",
  "tool",
  "output",
  "branch",
  "filter",
  "fanout",
  "merge",
  "loop",
  "human",
  "subroutine",
] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  name?: string;
  x?: number;
  y?: number;
  /** Per-kind config, e.g. { agentId } for an agent, { tool } for an output. */
  config?: Record<string, unknown>;
}
export interface FlowEdge {
  id?: string;
  from: string;
  /** Output port on the source node (branch/fan-out have several); default "". */
  fromPort?: string;
  to: string;
}
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export type FlowTrigger =
  | { kind: "schedule"; cron: string }
  | { kind: "event"; channel: string }
  | { kind: "manual" };

/** What flows down a wire: an agent's prose report + its structured signal. */
export interface FlowPayload {
  report?: string;
  signal?: Record<string, unknown> | null;
  from?: string;
}

export const flows = pgTable("flows", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  graph: jsonb("graph").$type<FlowGraph>().notNull().default({ nodes: [], edges: [] }),
  trigger: jsonb("trigger").$type<FlowTrigger>(),
  enabled: boolean("enabled").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flowRuns = pgTable(
  "flow_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    flowId: uuid("flow_id").notNull(),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status", { enum: FLOW_RUN_STATUSES }).notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("flow_runs_flow").on(t.flowId, t.createdAt)],
);

export const flowNodeRuns = pgTable(
  "flow_node_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    flowRunId: uuid("flow_run_id").notNull(),
    nodeId: text("node_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status", { enum: NODE_RUN_STATUSES }).notNull().default("pending"),
    /** The real agent_run this node produced, when it's an agent node. */
    agentRunId: uuid("agent_run_id"),
    /** The payload that arrived on this node's input wire(s). */
    input: jsonb("input"),
    /** The payload this node passes downstream ({ report, signal }). */
    output: jsonb("output"),
    /** Structured signal an agent node set via the flow.emit tool. */
    signal: jsonb("signal"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("flow_node_runs_run").on(t.flowRunId)],
);

export type Flow = typeof flows.$inferSelect;
export type FlowRun = typeof flowRuns.$inferSelect;
export type FlowNodeRun = typeof flowNodeRuns.$inferSelect;
