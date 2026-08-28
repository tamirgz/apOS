/**
 * Agent documentation, DERIVED (not hand-maintained) from an agent's real
 * configuration so it can never drift: what it READS (its input tools + what
 * each provides), what it SUGGESTS/does (its write tools), how it DECIDES (its
 * prompt), and how it LEARNS (the shared self-learning loop). Rendered in the
 * Agents UI and exported to docs/AGENTS-REFERENCE.md by scripts/gen-agent-docs.
 */
import { getAllTools } from "@/core/ai/tool-registry";
import { serverModules } from "@/modules/registry.server";
import type { AgentTemplate } from "@/core/modules/types.server";

// A tool is an OUTPUT (suggest/act) if its action verb mutates; otherwise it's
// an INPUT the agent reads to work. Ledger + memory tools are internal plumbing
// (idempotency + the learning loop) and are documented under "learns", not here.
const WRITE_VERB =
  /^(set|raise|record|create|update|remember|resolve|mark|send|add|delete|new|patch|write|close|promote|assign)/i;
const INTERNAL = /^(ledger|memory)\./;

const action = (name: string) => name.split(".")[1] ?? name;
const isWrite = (name: string) => WRITE_VERB.test(action(name));

/** First sentence of a tool description, trimmed — enough to say what it provides. */
function gist(desc: string): string {
  const s = desc.trim().split(/(?<=[.!?])\s/)[0] ?? desc;
  return s.length > 220 ? s.slice(0, 217).trimEnd() + "…" : s;
}

export interface AgentDocEntry {
  name: string;
  gist: string;
}
export interface AgentDocView {
  reads: AgentDocEntry[];
  suggests: AgentDocEntry[];
  /** The agent's own instructions — how it decides. */
  decides: string;
  learns: string;
}

export const AGENT_LEARNS =
  "Self-learning: after each run it reflects on what it did and, if there's something worth remembering, stores a one-line lesson scoped to itself in the shared 3-layer memory; at its next run it recalls its own past lessons and applies them. Persistent failures also feed the weekly distill that rewrites the shared operating rules injected into every agent run.";

/** Build the doc view for a set of tool names + a prompt. */
export function describeAgent(toolNames: string[], prompt: string): AgentDocView {
  const byName = new Map(getAllTools().map((t) => [t.name, t.description]));
  const entry = (name: string): AgentDocEntry => ({
    name,
    gist: gist(byName.get(name) ?? "(tool not found in registry)"),
  });
  const shown = toolNames.filter((n) => !INTERNAL.test(n));
  return {
    reads: shown.filter((n) => !isWrite(n)).map(entry),
    suggests: shown.filter(isWrite).map(entry),
    decides: prompt.trim(),
    learns: AGENT_LEARNS,
  };
}

/** Every agent template across all modules, with its derived doc. */
export function allAgentTemplateDocs(): {
  template: AgentTemplate;
  module: string;
  doc: AgentDocView;
}[] {
  return serverModules.flatMap((m) =>
    (m.agentTemplates ?? []).map((t) => ({
      template: t,
      module: m.id,
      doc: describeAgent(t.defaultTools, t.defaultPrompt),
    })),
  );
}

/** Doc for a persisted agent, matched to its template by name (falls back to the
 *  agent's own live tools + prompt so a customised agent still documents right). */
export function agentDoc(agent: {
  name: string;
  tools: string[];
  prompt: string;
}): AgentDocView {
  return describeAgent(agent.tools, agent.prompt);
}
