"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import type { FlowNode } from "@/modules/flows/schema";
import { AI_PROVIDERS, type AIProviderId } from "@/core/db/schema/ai-routes";
import { useProviderModels } from "@/core/ui/useProviderModels";
import { metaFor } from "../nodes";
import type { NodeTranscript } from "../actions";
import type { AgentOption, FlowOption, NodeRunView, ToolOption } from "../queries";

type Patch = { name?: string; config?: Record<string, unknown> };

const fieldCls =
  "w-full rounded-lg glass px-2.5 py-1.5 text-sm text-ink outline-none focus:glass-edge";
const labelCls =
  "block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint";

/** Right rail — configure the selected node + inspect its last run. */
export function Inspector({
  node,
  agents,
  flows,
  tools,
  run,
  onPatch,
  onDelete,
  onLoadTranscript,
  onCreateAgent,
}: {
  node: FlowNode;
  agents: AgentOption[];
  flows: FlowOption[];
  tools: ToolOption[];
  /** This node's run in the effective trace (null = it hasn't run in this run). */
  run?: NodeRunView | null;
  onPatch: (patch: Patch) => void;
  onDelete: () => void;
  onLoadTranscript?: (agentRunId: string) => Promise<NodeTranscript | null>;
  onCreateAgent?: (name: string) => Promise<AgentOption | null>;
}) {
  const meta = metaFor(node.kind);
  const cfg = node.config ?? {};
  const setCfg = (k: string, v: unknown) => onPatch({ config: { ...cfg, [k]: v } });
  const ports = (cfg.ports as string[] | undefined) ?? meta.defaultPorts ?? ["yes", "no"];

  return (
    <div className="flex max-h-[75vh] w-64 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          <meta.Icon className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-ink-faint">
          {meta.label}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className={labelCls}>name</span>
        <input
          className={fieldCls}
          value={node.name ?? ""}
          placeholder={meta.label}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </label>

      {node.kind === "agent" && (
        <AgentConfig
          cfg={cfg}
          agents={agents}
          setCfg={setCfg}
          onPatch={onPatch}
          onCreateAgent={onCreateAgent}
        />
      )}

      {node.kind === "source" && <SourceConfig cfg={cfg} setCfg={setCfg} />}

      {node.kind === "tool" && <ToolConfig cfg={cfg} setCfg={setCfg} tools={tools} />}

      {(node.kind === "branch" || node.kind === "filter") && (
        <ConditionField cfg={cfg} setCfg={setCfg} />
      )}

      {node.kind === "branch" && (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>ports (true / else)</span>
          <div className="flex gap-2">
            {[0, 1].map((i) => (
              <input
                key={i}
                className={fieldCls}
                value={ports[i] ?? ""}
                onChange={(e) => {
                  const next = [...ports];
                  next[i] = e.target.value;
                  setCfg("ports", next);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {node.kind === "human" && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>ask</span>
          <textarea
            className={`${fieldCls} min-h-16 resize-y`}
            value={(cfg.prompt as string) ?? ""}
            placeholder="Approve the draft before it's sent?"
            onChange={(e) => setCfg("prompt", e.target.value)}
          />
          <span className="text-[11px] text-ink-faint">
            The flow pauses here until you Approve (continue) or Reject (stop the
            downstream path) from the run trace.
          </span>
        </label>
      )}

      {node.kind === "output" && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>deliver via</span>
          <select
            className={fieldCls}
            value={(cfg.tool as string) ?? "notify"}
            onChange={(e) => setCfg("tool", e.target.value)}
          >
            <option value="notify">Bell + Slack</option>
            <option value="card">Needs-you card</option>
            <option value="slack">Slack (if configured)</option>
            <option value="cockpit">Cockpit brief</option>
          </select>
          <span className="text-[11px] text-ink-faint">
            Where the flow&apos;s final result is delivered.
          </span>
        </label>
      )}

      {(node.kind === "subroutine" || node.kind === "loop") && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>{node.kind === "loop" ? "run per item" : "run flow"}</span>
          <select
            className={fieldCls}
            value={(cfg.flowId as string) ?? ""}
            onChange={(e) => setCfg("flowId", e.target.value)}
          >
            <option value="">— pick a flow —</option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {!cfg.flowId && (
            <span className="text-[11px] text-flare">Choose the flow to run.</span>
          )}
          {flows.length === 0 && (
            <span className="text-[11px] text-ink-faint">
              Create another flow first — it becomes the callable here.
            </span>
          )}
        </label>
      )}

      {node.kind === "loop" && (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className={labelCls}>items key</span>
            <input
              className={fieldCls}
              value={(cfg.itemsKey as string) ?? ""}
              placeholder="items"
              onChange={(e) => setCfg("itemsKey", e.target.value)}
            />
          </label>
          <label className="flex w-20 flex-col gap-1">
            <span className={labelCls}>max</span>
            <input
              type="number"
              min={1}
              max={50}
              className={fieldCls}
              value={(cfg.maxIterations as number) ?? 10}
              onChange={(e) => setCfg("maxIterations", Number(e.target.value))}
            />
          </label>
        </div>
      )}

      {node.kind === "loop" && (
        <p className="text-[11px] text-ink-faint">
          Iterates the array at <code>signal.{(cfg.itemsKey as string) || "items"}</code> from
          the upstream step, running the chosen flow once per item.
        </p>
      )}

      {(node.kind === "fanout" || node.kind === "merge" || node.kind === "trigger") && (
        <p className="text-[11px] text-ink-faint">{meta.blurb}. No configuration needed.</p>
      )}

      {run && <RunDetail run={run} onLoadTranscript={onLoadTranscript} />}

      <button
        type="button"
        onClick={onDelete}
        className="mt-1 flex items-center justify-center gap-2 rounded-lg border border-flare/25 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-flare transition hover:bg-flare/10"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete node
      </button>
    </div>
  );
}

/** Agent node: pick/create the agent, override its model per-flow, see its reach. */
function AgentConfig({
  cfg,
  agents,
  setCfg,
  onPatch,
  onCreateAgent,
}: {
  cfg: Record<string, unknown>;
  agents: AgentOption[];
  setCfg: (k: string, v: unknown) => void;
  onPatch: (patch: Patch) => void;
  onCreateAgent?: (name: string) => Promise<AgentOption | null>;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = agents.find((a) => a.id === cfg.agentId);
  const provider = (cfg.provider as AIProviderId | "") ?? "";
  const { models } = useProviderModels(provider);
  const model = (cfg.model as string) ?? "";

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>agent</span>
        <select
          className={fieldCls}
          value={(cfg.agentId as string) ?? ""}
          onChange={(e) => setCfg("agentId", e.target.value)}
        >
          <option value="">— pick an agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {!cfg.agentId && !creating && (
          <span className="text-[11px] text-flare">Choose an agent to run here.</span>
        )}
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-fit items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:text-ink"
          >
            <Plus className="h-3 w-3" /> new agent
          </button>
        ) : (
          <div className="flex gap-1.5">
            <input
              autoFocus
              className={fieldCls}
              value={newName}
              placeholder="agent name…"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button
              type="button"
              disabled={busy || !newName.trim() || !onCreateAgent}
              onClick={async () => {
                if (!onCreateAgent) return;
                setBusy(true);
                const opt = await onCreateAgent(newName.trim());
                setBusy(false);
                if (opt) {
                  setCfg("agentId", opt.id);
                  setCreating(false);
                  setNewName("");
                }
              }}
              className="flex items-center rounded-lg bg-ion/15 px-2.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "add"}
            </button>
          </div>
        )}
      </label>

      {/* Per-flow model override — this node can pin a different model than the
          agent's own default (Flow A → big model, Flow B → fast local). */}
      <div className="flex flex-col gap-1">
        <span className={labelCls}>model (this node)</span>
        <select
          className={fieldCls}
          value={provider}
          onChange={(e) =>
            // One patch — two setCfg calls would each read the same stale cfg,
            // so the second (clearing model) would clobber the provider.
            onPatch({ config: { ...cfg, provider: e.target.value || undefined, model: undefined } })
          }
        >
          <option value="">agent default</option>
          {AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {provider && (
          <select
            className={fieldCls}
            value={model}
            onChange={(e) => setCfg("model", e.target.value || undefined)}
          >
            {model && !models.includes(model) && <option value={model}>{model}</option>}
            <option value="">{models.length ? "select model…" : "loading…"}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {!provider && (
          <span className="text-[11px] text-ink-faint">
            Uses the agent&apos;s own model
            {selected?.model ? ` (${selected.provider ?? "?"}/${selected.model})` : ""}.
          </span>
        )}
      </div>

      {/* Data reach — the agent's allowed tools (its sources & actions). */}
      {selected && (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>data reach ({selected.tools.length} tools)</span>
          {selected.tools.length ? (
            <div className="flex flex-wrap gap-1">
              {selected.tools.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-md border border-ion/25 bg-ion/8 px-1.5 py-0.5 font-mono text-[9px] text-ion"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-[11px] text-ink-faint">
              No tools — reads only its upstream input.
            </span>
          )}
          <span className="text-[10px] text-ink-faint">
            Edit the agent&apos;s tools on the Agents page.
          </span>
        </div>
      )}
    </div>
  );
}

/** Source node: inject a concrete data source as the flow's input. */
function SourceConfig({
  cfg,
  setCfg,
}: {
  cfg: Record<string, unknown>;
  setCfg: (k: string, v: unknown) => void;
}) {
  const type = (cfg.sourceType as string) ?? "text";
  const needsQuery = type === "search" || type === "knowledge";
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>source</span>
        <select
          className={fieldCls}
          value={type}
          onChange={(e) => setCfg("sourceType", e.target.value)}
        >
          <option value="text">Text — a fixed brief</option>
          <option value="search">Semantic search — whole corpus</option>
          <option value="knowledge">Knowledge / vault — notes & vault</option>
          <option value="projects">Projects — active + health</option>
          <option value="people">People & meetings — follow-ups</option>
        </select>
      </label>
      {needsQuery && (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className={labelCls}>query</span>
            <input
              className={fieldCls}
              value={(cfg.query as string) ?? ""}
              placeholder="anti-phishing news"
              onChange={(e) => setCfg("query", e.target.value)}
            />
          </label>
          <label className="flex w-16 flex-col gap-1">
            <span className={labelCls}>limit</span>
            <input
              type="number"
              min={1}
              max={25}
              className={fieldCls}
              value={(cfg.limit as number) ?? 8}
              onChange={(e) => setCfg("limit", Number(e.target.value))}
            />
          </label>
        </div>
      )}
      {type === "text" && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>text</span>
          <textarea
            className={`${fieldCls} min-h-16 resize-y`}
            value={(cfg.text as string) ?? ""}
            placeholder="A fixed instruction / context to feed the next step."
            onChange={(e) => setCfg("text", e.target.value)}
          />
        </label>
      )}
      {(type === "projects" || type === "people") && (
        <span className="text-[11px] text-ink-faint">
          Pulls your {type === "projects" ? "active projects with their health & next action" : "people with their open follow-ups"} as the input. No configuration needed.
        </span>
      )}
    </div>
  );
}

/** Common signal keys agents/branches emit — the condition builder's presets. */
const COND_FIELDS = ["state", "score", "decision", "approved", "count", "priority", "health", "pass"];
const COND_OPS = ["==", "!=", ">=", "<=", ">", "<", "contains"];
const COND_RE = /^\s*([\w.]+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$/i;

/** Filter/Branch condition — a field/op/value builder with preset choices AND a
 *  free-text escape for a natural-language condition (the local yes/no judge). */
function ConditionField({
  cfg,
  setCfg,
}: {
  cfg: Record<string, unknown>;
  setCfg: (k: string, v: unknown) => void;
}) {
  const cond = (cfg.condition as string) ?? "";
  const parsed = cond.match(COND_RE);
  // Free-text mode when there's a condition that ISN'T a simple field/op/value.
  const [free, setFree] = useState(() => cond.trim() !== "" && !parsed);
  const field = parsed?.[1] ?? "";
  const op = parsed?.[2] ?? "==";
  const value = parsed?.[3] ?? "";
  const setPart = (f: string, o: string, v: string) =>
    setCfg("condition", `${f || "state"} ${o} ${v}`.trim());

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={labelCls}>condition</span>
        <button
          type="button"
          onClick={() => setFree((f) => !f)}
          className="font-mono text-[9px] uppercase tracking-widest text-ion transition hover:text-ink"
        >
          {free ? "use builder" : "free text"}
        </button>
      </div>
      {free ? (
        <>
          <textarea
            className={`${fieldCls} min-h-14 resize-y`}
            value={cond}
            placeholder="the report recommends escalating to a person"
            onChange={(e) => setCfg("condition", e.target.value)}
          />
          <span className="text-[11px] text-ink-faint">
            Natural-language → a local yes/no judge decides on the upstream report.
          </span>
        </>
      ) : (
        <>
          <div className="flex gap-1.5">
            <input
              list="cond-fields"
              className={`${fieldCls} flex-1`}
              value={field}
              placeholder="field"
              onChange={(e) => setPart(e.target.value, op, value)}
            />
            <select
              className={`${fieldCls} w-20`}
              value={op}
              onChange={(e) => setPart(field, e.target.value, value)}
            >
              {COND_OPS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <datalist id="cond-fields">
            {COND_FIELDS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <input
            className={fieldCls}
            value={value}
            placeholder="value (e.g. escalate, 7, true)"
            onChange={(e) => setPart(field, op, e.target.value)}
          />
          <span className="text-[11px] text-ink-faint">
            Reads the upstream <code>signal</code>. Pick a field or type your own.
          </span>
        </>
      )}
    </div>
  );
}

/** Tool/action node — run one registered tool directly, args from a JSON
 *  template that can interpolate {{report}} / {{signal.key}} from upstream. */
function ToolConfig({
  cfg,
  setCfg,
  tools,
}: {
  cfg: Record<string, unknown>;
  setCfg: (k: string, v: unknown) => void;
  tools: ToolOption[];
}) {
  const selected = (cfg.tool as string) ?? "";
  const def = tools.find((t) => t.name === selected);
  return (
    <div className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className={labelCls}>tool</span>
        <select
          className={fieldCls}
          value={selected}
          onChange={(e) => setCfg("tool", e.target.value)}
        >
          <option value="">— pick a tool —</option>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        {!selected && <span className="text-[11px] text-flare">Choose a tool to run.</span>}
        {def && <span className="text-[11px] text-ink-faint">{def.description}</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>args (JSON)</span>
        <textarea
          className={`${fieldCls} min-h-16 resize-y font-mono text-[11px]`}
          value={(cfg.args as string) ?? ""}
          placeholder={'{ "title": "{{report}}" }'}
          onChange={(e) => setCfg("args", e.target.value)}
        />
        <span className="text-[11px] text-ink-faint">
          Interpolate <code>{"{{report}}"}</code> / <code>{"{{signal.key}}"}</code> from the
          upstream step.
        </span>
      </label>
    </div>
  );
}

/** The selected node's last run: status, input, output, signal, transcript. */
function RunDetail({
  run,
  onLoadTranscript,
}: {
  run: NodeRunView;
  onLoadTranscript?: (agentRunId: string) => Promise<NodeTranscript | null>;
}) {
  const [tx, setTx] = useState<NodeTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const inReport = run.input?.report;
  const inSignal = run.input?.signal;
  const statusColor =
    run.status === "succeeded"
      ? "var(--color-plasma)"
      : run.status === "failed"
        ? "var(--color-flare)"
        : "var(--color-ink-faint)";

  return (
    <div className="flex flex-col gap-2 border-t border-white/8 pt-3">
      <div className="flex items-center gap-2">
        <span className={labelCls}>last run</span>
        <span
          className="font-mono text-[10px] uppercase tracking-widest"
          style={{ color: statusColor }}
        >
          {run.status}
        </span>
      </div>

      {inReport && (
        <Field label="input">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-dim">
            {String(inReport).slice(0, 600)}
          </p>
        </Field>
      )}
      {inSignal && Object.keys(inSignal).length > 0 && (
        <Field label="input signal">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] text-ink-faint">
            {JSON.stringify(inSignal, null, 1)}
          </pre>
        </Field>
      )}
      {run.report && (
        <Field label="output">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-dim">
            {run.report.slice(0, 600)}
          </p>
        </Field>
      )}
      {run.signal && Object.keys(run.signal).length > 0 && (
        <Field label="signal">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] text-ink-faint">
            {JSON.stringify(run.signal, null, 1)}
          </pre>
        </Field>
      )}
      {run.error && (
        <Field label="error">
          <p className="font-mono text-[10px] text-flare">{run.error}</p>
        </Field>
      )}

      {run.agentRunId && onLoadTranscript && (
        <>
          {!tx ? (
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                setTx(await onLoadTranscript(run.agentRunId!));
                setLoading(false);
              }}
              className="flex w-fit items-center gap-1.5 rounded-lg border border-white/8 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:text-ink"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
              show transcript
            </button>
          ) : (
            <Transcript tx={tx} />
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">{label}</span>
      {children}
    </div>
  );
}

/** The agent's step-by-step: tool calls, their results, its text, errors. */
function Transcript({ tx }: { tx: NodeTranscript }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/5 pt-2">
      <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
        transcript · {tx.tokensIn + tx.tokensOut > 0 ? `${tx.tokensIn}▾ ${tx.tokensOut}▴ tok` : "—"}
      </span>
      {tx.events.map((e, i) => {
        if (e.type === "tool_call") {
          return (
            <span
              key={i}
              className="inline-flex w-fit items-center gap-1 rounded-md border border-ion/25 bg-ion/8 px-1.5 py-0.5 font-mono text-[9px] text-ion"
            >
              <Wrench className="h-2.5 w-2.5" />
              {e.name}
            </span>
          );
        }
        if (e.type === "tool_result") {
          const s = JSON.stringify(e.result ?? "");
          return (
            <p key={i} className="font-mono text-[9px] leading-relaxed text-ink-faint">
              ↳ {s.length > 160 ? s.slice(0, 160) + "…" : s}
            </p>
          );
        }
        if (e.type === "text" && e.text) {
          return (
            <p key={i} className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink-dim">
              {e.text.slice(0, 500)}
            </p>
          );
        }
        if (e.type === "error") {
          return (
            <p key={i} className="font-mono text-[10px] text-flare">
              {e.message}
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}
