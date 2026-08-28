"use client";

import { Trash2 } from "lucide-react";
import type { FlowNode } from "@/modules/flows/schema";
import { metaFor } from "../nodes";
import type { AgentOption } from "../queries";

type Patch = { name?: string; config?: Record<string, unknown> };

const fieldCls =
  "w-full rounded-lg glass px-2.5 py-1.5 text-sm text-ink outline-none focus:glass-edge";
const labelCls =
  "block font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint";

/** Right rail — configure the selected node. */
export function Inspector({
  node,
  agents,
  onPatch,
  onDelete,
}: {
  node: FlowNode;
  agents: AgentOption[];
  onPatch: (patch: Patch) => void;
  onDelete: () => void;
}) {
  const meta = metaFor(node.kind);
  const cfg = node.config ?? {};
  const setCfg = (k: string, v: unknown) => onPatch({ config: { ...cfg, [k]: v } });
  const ports = (cfg.ports as string[] | undefined) ?? meta.defaultPorts ?? ["yes", "no"];

  return (
    <div className="flex w-64 flex-col gap-3">
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
          {!cfg.agentId && (
            <span className="text-[11px] text-flare">Choose an agent to run here.</span>
          )}
        </label>
      )}

      {(node.kind === "branch" || node.kind === "filter") && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>condition</span>
          <input
            className={fieldCls}
            value={(cfg.condition as string) ?? ""}
            placeholder="decision == escalate"
            onChange={(e) => setCfg("condition", e.target.value)}
          />
          <span className="text-[11px] text-ink-faint">
            Reads the upstream signal (e.g. <code>score &gt;= 7</code>); free text
            falls back to a local yes/no judge.
          </span>
        </label>
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

      {node.kind === "output" && (
        <label className="flex flex-col gap-1">
          <span className={labelCls}>deliver via</span>
          <select
            className={fieldCls}
            value={(cfg.tool as string) ?? "notify"}
            onChange={(e) => setCfg("tool", e.target.value)}
          >
            <option value="notify">notify</option>
          </select>
        </label>
      )}

      {(node.kind === "fanout" || node.kind === "merge" || node.kind === "trigger") && (
        <p className="text-[11px] text-ink-faint">{meta.blurb}. No configuration needed.</p>
      )}

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
