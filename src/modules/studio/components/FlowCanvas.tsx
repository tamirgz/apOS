"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  History,
  Loader2,
  Play,
  Undo2,
  UserCheck,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
} from "react";
import { cn } from "@/core/ui/cn";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import type {
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowNodeKind,
  FlowTrigger,
} from "@/modules/flows/schema";
import {
  decideFlowStep,
  loadNodeTranscript,
  loadRunView,
  quickCreateAgent,
  runFlowNow,
  saveFlowGraph,
  renameFlow,
} from "../actions";
import type {
  AgentOption,
  FlowOption,
  FlowStats,
  NodeRunView,
  RunMeta,
  RunView,
} from "../queries";
import { Inspector } from "./Inspector";
import { NodePalette } from "./NodePalette";
import { ScheduleControl } from "./ScheduleControl";
import { hasCycle } from "../graph";
import { KIND_META, NODE_H, NODE_W, metaFor, outputPortsOf } from "../nodes";

type Edge = FlowEdge & { id: string };
type View = { x: number; y: number; k: number };

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const STATUS_RING: Record<string, string> = {
  running: "var(--color-plasma)",
  succeeded: "#16a97a",
  failed: "var(--color-flare)",
  paused: "#e0a94a",
};

const fmtDur = (a: number | null, b: number | null): string => {
  if (a == null || b == null) return "";
  const d = b - a;
  return d < 1000 ? `${d}ms` : `${(d / 1000).toFixed(1)}s`;
};
const fmtMs = (ms: number | null) =>
  ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const fmtTokens = (t: number) =>
  t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : `${t}`;
const relTime = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const inPos = (n: FlowNode) => ({ x: (n.x ?? 0), y: (n.y ?? 0) + NODE_H / 2 });
const outPos = (n: FlowNode, i: number, count: number) => ({
  x: (n.x ?? 0) + NODE_W,
  y: (n.y ?? 0) + (NODE_H * (i + 1)) / (count + 1),
});
const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
};

export function FlowCanvas({
  flow,
  agents,
  flows,
  stats,
  trace,
  recentRuns,
}: {
  flow: {
    id: string;
    name: string;
    graph: FlowGraph;
    trigger: FlowTrigger;
    enabled: boolean;
  };
  agents: AgentOption[];
  flows: FlowOption[];
  stats: FlowStats;
  trace: RunView | null;
  recentRuns: RunMeta[];
}) {
  const [nodes, setNodes] = useState<FlowNode[]>(() => flow.graph.nodes ?? []);
  const [edges, setEdges] = useState<Edge[]>(() =>
    (flow.graph.edges ?? []).map((e) => ({ ...e, id: e.id ?? uid("e") })),
  );
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const [view, setView] = useState<View>({ x: 40, y: 20, k: 1 });
  // Agents created inline from the inspector, merged over the server-passed list
  // so a fresh "+ new agent" is immediately selectable without a round-trip.
  const [extraAgents, setExtraAgents] = useState<AgentOption[]>([]);
  const allAgents = useMemo(
    () => [...agents, ...extraAgents.filter((e) => !agents.some((a) => a.id === e.id))],
    [agents, extraAgents],
  );
  const [name, setName] = useState(flow.name);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [wire, setWire] = useState<{ from: string; fromPort: string; x: number; y: number } | null>(null);
  const [optimisticRun, setOptimisticRun] = useState(false);
  // Run picker: null = follow the live/latest run (prop); else a fetched past run.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const [pickedTrace, setPickedTrace] = useState<RunView | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const gesture = useRef<
    | { mode: "pan"; lx: number; ly: number }
    | { mode: "drag"; id: string; lx: number; ly: number }
    | { mode: "wire"; from: string; fromPort: string }
    | null
  >(null);
  const lastSaved = useRef(JSON.stringify({ nodes, edges }));
  // Undo: settled graph states, most-recent last, capped at 5 deep.
  const stableRef = useRef(JSON.stringify({ nodes, edges }));
  const undoRef = useRef<string[]>([]);

  // Capture an undo step once an edit settles (coalesces drags + typing bursts).
  useEffect(() => {
    const cur = JSON.stringify({ nodes, edges });
    if (cur === stableRef.current) return;
    const t = setTimeout(() => {
      undoRef.current.push(stableRef.current);
      if (undoRef.current.length > 5) undoRef.current.shift();
      stableRef.current = cur;
      setUndoDepth(undoRef.current.length);
    }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const undo = () => {
    const prev = undoRef.current.pop();
    if (prev === undefined) return;
    stableRef.current = prev; // restore is not itself a new undo step
    const g = JSON.parse(prev) as { nodes: FlowNode[]; edges: Edge[] };
    setNodes(g.nodes);
    setEdges(g.edges);
    setSelected(null);
    setUndoDepth(undoRef.current.length);
  };

  // Live trace — SSE refreshes the server component, which re-passes `trace`.
  // The first flow_runs event after a Run also clears the optimistic state.
  useLiveEvents(["flow_runs"], () => setOptimisticRun(false));
  // Effective trace: the picked past run, else the live latest run.
  const effTrace = pickedRunId ? pickedTrace : trace;
  const statusByNode = new Map<string, NodeRunView>();
  for (const n of effTrace?.nodes ?? []) statusByNode.set(n.nodeId, n);
  const isRunning = trace?.status === "running" || trace?.status === "queued";

  const pickRun = (id: string) => {
    if (id === "" || (trace && id === trace.runId)) {
      setPickedRunId(null);
      setPickedTrace(null);
      return;
    }
    setPickedRunId(id);
    loadRunView(id).then(setPickedTrace);
  };

  // Debounced autosave of the graph.
  useEffect(() => {
    const serialized = JSON.stringify({ nodes, edges });
    if (serialized === lastSaved.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      await saveFlowGraph(flow.id, { nodes, edges } as FlowGraph);
      lastSaved.current = serialized;
      setSaveState("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [nodes, edges, flow.id]);

  // Native non-passive wheel → zoom around the cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const k = clamp(v.k * (e.deltaY < 0 ? 1.1 : 0.9), 0.4, 2.2);
        const wx = (cx - v.x) / v.k;
        const wy = (cy - v.y) / v.k;
        return { x: cx - wx * k, y: cy - wy * k, k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Delete key removes the selection; Cmd/Ctrl+Z undoes (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (typing) return;
        const prev = undoRef.current.pop();
        if (prev === undefined) return;
        e.preventDefault();
        stableRef.current = prev;
        const g = JSON.parse(prev) as { nodes: FlowNode[]; edges: Edge[] };
        setNodes(g.nodes);
        setEdges(g.edges);
        setSelected(null);
        setUndoDepth(undoRef.current.length);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (typing) return;
      if (!selected) return;
      e.preventDefault();
      if (selected.kind === "node") {
        setNodes((ns) => ns.filter((n) => n.id !== selected.id));
        setEdges((es) => es.filter((x) => x.from !== selected.id && x.to !== selected.id));
      } else {
        setEdges((es) => es.filter((x) => x.id !== selected.id));
      }
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const patchNode = (
    id: string,
    patch: { name?: string; x?: number; y?: number; config?: Record<string, unknown> },
  ) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  const removeNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
  };

  const addNode = (kind: FlowNodeKind) => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    const v = viewRef.current;
    const cx = rect ? ((rect.width / 2 - v.x) / v.k) : 200;
    const cy = rect ? ((rect.height / 2 - v.y) / v.k) : 200;
    const config: Record<string, unknown> =
      kind === "branch"
        ? { ports: ["yes", "no"], condition: "" }
        : kind === "filter"
          ? { condition: "" }
          : kind === "output"
            ? { tool: "notify" }
            : kind === "loop"
              ? { itemsKey: "items", maxIterations: 10 }
              : kind === "human"
                ? { prompt: "" }
                : {};
    const node: FlowNode = {
      id: uid(kind),
      kind,
      name: KIND_META[kind].label,
      x: Math.round(cx - NODE_W / 2),
      y: Math.round(cy - NODE_H / 2),
      config,
    };
    setNodes((ns) => [...ns, node]);
    setSelected({ kind: "node", id: node.id });
  };

  // ── pointer gestures ────────────────────────────────────────────────────
  const capture = (e: RPointerEvent) => containerRef.current?.setPointerCapture(e.pointerId);

  const onBgDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).dataset.bg !== "1") return;
    setSelected(null);
    gesture.current = { mode: "pan", lx: e.clientX, ly: e.clientY };
    capture(e);
  };
  const onNodeDown = (e: RPointerEvent, id: string) => {
    e.stopPropagation();
    setSelected({ kind: "node", id });
    gesture.current = { mode: "drag", id, lx: e.clientX, ly: e.clientY };
    capture(e);
  };
  const onPortDown = (e: RPointerEvent, from: string, fromPort: string) => {
    e.stopPropagation();
    gesture.current = { mode: "wire", from, fromPort };
    const p = toWorld(e.clientX, e.clientY);
    setWire({ from, fromPort, x: p.x, y: p.y });
    capture(e);
  };

  const toWorld = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k };
  };

  const onMove = (e: RPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === "pan") {
      const dx = e.clientX - g.lx;
      const dy = e.clientY - g.ly;
      g.lx = e.clientX;
      g.ly = e.clientY;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (g.mode === "drag") {
      const k = viewRef.current.k;
      const dx = (e.clientX - g.lx) / k;
      const dy = (e.clientY - g.ly) / k;
      g.lx = e.clientX;
      g.ly = e.clientY;
      setNodes((ns) =>
        ns.map((n) => (n.id === g.id ? { ...n, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy } : n)),
      );
    } else if (g.mode === "wire") {
      const p = toWorld(e.clientX, e.clientY);
      setWire((w) => (w ? { ...w, x: p.x, y: p.y } : w));
    }
  };
  const onUp = (e: RPointerEvent) => {
    const g = gesture.current;
    if (g?.mode === "wire") {
      // Pointer capture suppresses enter/leave on ports, so find the nearest
      // input port to the drop point geometrically instead.
      const p = toWorld(e.clientX, e.clientY);
      let target: string | null = null;
      let best = 22 * 22;
      for (const n of nodes) {
        if (!metaFor(n.kind).hasInput) continue;
        const ip = inPos(n);
        const d = (ip.x - p.x) ** 2 + (ip.y - p.y) ** 2;
        if (d < best) {
          best = d;
          target = n.id;
        }
      }
      if (target && target !== g.from) {
        const from = g.from;
        const fromPort = g.fromPort;
        const to = target;
        setEdges((es) =>
          es.some((x) => x.from === from && x.fromPort === fromPort && x.to === to)
            ? es
            : [...es, { id: uid("e"), from, fromPort, to }],
        );
      }
    }
    gesture.current = null;
    setWire(null);
  };

  const onRun = async () => {
    setOptimisticRun(true);
    await runFlowNow(flow.id);
  };
  const commitName = async () => {
    if (name.trim() && name !== flow.name) await renameFlow(flow.id, name.trim());
  };
  const onExport = () => {
    const data = JSON.stringify({ name, graph: { nodes, edges } }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow"}.flow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedNode = selected?.kind === "node" ? nodes.find((n) => n.id === selected.id) : null;
  const running = isRunning || optimisticRun;
  // A live (not a past-run) human gate awaiting a decision.
  const pausedRun =
    !pickedRunId && trace?.status === "paused"
      ? trace.nodes.find((n) => n.status === "paused")
      : null;
  const pausedNode = pausedRun ? nodes.find((n) => n.id === pausedRun.nodeId) : null;
  const cyclic = hasCycle(nodes, edges);

  return (
    <div className="relative h-[calc(100vh-7rem)] overflow-hidden rounded-2xl glass">
      {/* toolbar */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 border-b border-ink/5 px-4 py-2.5">
        <Link href="/m/studio" className="text-ink-faint transition hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <input
          className="min-w-0 flex-1 bg-transparent font-display text-lg font-semibold text-ink outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {stats.runs > 0 && (
          <span className="hidden items-center gap-2.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint sm:flex">
            <span>{stats.runs} runs</span>
            <span>{Math.round((stats.succeeded / stats.runs) * 100)}% ok</span>
            <span>{fmtMs(stats.avgMs)}</span>
            {stats.tokens > 0 && <span>{fmtTokens(stats.tokens)} tok</span>}
          </span>
        )}
        {cyclic && (
          <span
            className="flex items-center gap-1.5 rounded-lg border border-flare/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-flare"
            title="This flow has a cycle — the engine can't run it until you remove the loop-back edge."
          >
            <AlertTriangle className="h-3.5 w-3.5" /> cycle
          </span>
        )}
        <button
          type="button"
          onClick={undo}
          disabled={undoDepth === 0}
          title="Undo (⌘Z) — up to 5 steps"
          className="rounded-lg border border-ink/15 p-1.5 text-ink-faint transition hover:text-ink disabled:opacity-30"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onExport}
          title="Export this flow as JSON"
          className="rounded-lg border border-ink/15 p-1.5 text-ink-faint transition hover:text-ink"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <SaveBadge state={saveState} />
        <ScheduleControl flowId={flow.id} trigger={flow.trigger} enabled={flow.enabled} />
        <button
          type="button"
          onClick={onRun}
          disabled={running || cyclic}
          title={cyclic ? "Remove the cycle before running" : undefined}
          className="flex items-center gap-2 rounded-lg border border-plasma/40 bg-plasma/10 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/20 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {running ? "running" : "run"}
        </button>
      </div>

      {/* left palette */}
      <div className="absolute left-3 top-16 z-10">
        <div className="glass rounded-xl p-2">
          <NodePalette onAdd={addNode} />
        </div>
      </div>

      {/* right inspector */}
      {selectedNode && (
        <div className="absolute right-3 top-16 z-10">
          <div className="glass rounded-xl p-3">
            <Inspector
              node={selectedNode}
              agents={allAgents}
              flows={flows}
              run={statusByNode.get(selectedNode.id) ?? null}
              onPatch={(patch) => patchNode(selectedNode.id, patch)}
              onDelete={() => {
                removeNode(selectedNode.id);
                setSelected(null);
              }}
              onLoadTranscript={loadNodeTranscript}
              onCreateAgent={async (name) => {
                const opt = await quickCreateAgent(name);
                setExtraAgents((p) => [...p, opt]);
                return opt;
              }}
            />
          </div>
        </div>
      )}

      {/* the pannable / zoomable surface */}
      <div
        ref={containerRef}
        data-bg="1"
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute inset-0 cursor-grab touch-none [background-image:radial-gradient(circle,color-mix(in_oklab,var(--color-ink)_9%,transparent)_1px,transparent_1px)] [background-size:22px_22px]"
        style={{ backgroundPosition: `${view.x}px ${view.y}px` }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
            {edges.map((e) => {
              const src = nodes.find((n) => n.id === e.from);
              const dst = nodes.find((n) => n.id === e.to);
              if (!src || !dst) return null;
              const ports = outputPortsOf(src.kind, src.config);
              const idx = Math.max(0, ports.indexOf(e.fromPort ?? ""));
              const a = outPos(src, idx, ports.length);
              const b = inPos(dst);
              const sel = selected?.kind === "edge" && selected.id === e.id;
              return (
                <g key={e.id}>
                  <path
                    d={edgePath(a, b)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      setSelected({ kind: "edge", id: e.id });
                    }}
                  />
                  <path
                    d={edgePath(a, b)}
                    fill="none"
                    stroke={sel ? "var(--color-flare)" : "color-mix(in oklab, var(--color-ink) 35%, transparent)"}
                    strokeWidth={sel ? 2.5 : 1.75}
                  />
                </g>
              );
            })}
            {wire &&
              (() => {
                const src = nodes.find((n) => n.id === wire.from);
                if (!src) return null;
                const ports = outputPortsOf(src.kind, src.config);
                const idx = Math.max(0, ports.indexOf(wire.fromPort));
                const a = outPos(src, idx, ports.length);
                return (
                  <path
                    d={edgePath(a, { x: wire.x, y: wire.y })}
                    fill="none"
                    stroke="var(--color-plasma)"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                  />
                );
              })()}
          </svg>

          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              agents={allAgents}
              flows={flows}
              selected={selected?.kind === "node" && selected.id === n.id}
              status={statusByNode.get(n.id)?.status}
              onDown={(e) => onNodeDown(e, n.id)}
              onPortDown={onPortDown}
            />
          ))}
        </div>
      </div>

      {/* bottom: run trace + selected-node detail */}
      {recentRuns.length > 0 && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex items-end justify-between gap-3">
          <div className="glass pointer-events-auto min-w-[240px] max-w-sm rounded-xl p-2.5">
            <div className="relative flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
                run
              </span>
              <select
                className="min-w-0 flex-1 rounded-md glass px-2 py-1 text-xs text-ink outline-none focus:glass-edge"
                value={pickedRunId ?? trace?.runId ?? ""}
                onChange={(e) => pickRun(e.target.value)}
              >
                {recentRuns.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {i === 0 ? "latest · " : ""}
                    {relTime(r.createdAt)} · {r.status}
                    {r.trigger !== "manual" ? ` · ${r.trigger}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                title="Run history"
                className={cn(
                  "rounded-md border border-ink/15 p-1 transition hover:text-ink",
                  showHistory ? "text-ink" : "text-ink-faint",
                )}
              >
                <History className="h-3.5 w-3.5" />
              </button>

              {showHistory && (
                <div className="absolute bottom-9 left-0 right-0 max-h-64 overflow-auto rounded-xl glass p-1.5">
                  <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">
                    history · {recentRuns.length}
                  </p>
                  {recentRuns.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        pickRun(r.id);
                        setShowHistory(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-plasma/5",
                        (pickedRunId ?? trace?.runId) === r.id && "bg-plasma/10",
                      )}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: STATUS_RING[r.status] ?? "var(--color-ink-faint)" }}
                      />
                      <span className="flex-1 truncate text-xs text-ink-dim">{relTime(r.createdAt)}</span>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                        {fmtDur(r.startedAt, r.finishedAt) || r.status}
                      </span>
                      {r.trigger !== "manual" && (
                        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                          {r.trigger}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {effTrace && (
              <div className="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: STATUS_RING[effTrace.status] ?? "var(--color-ink-faint)" }}
                />
                <span className="text-ink-dim">{effTrace.status}</span>
                <span className="text-ink-faint">{fmtDur(effTrace.startedAt, effTrace.finishedAt)}</span>
                <span className="ml-auto text-ink-faint">{effTrace.nodes.length} steps</span>
              </div>
            )}
          </div>

          {pausedRun && (
            <HumanGate
              flowId={flow.id}
              runId={trace!.runId}
              nodeId={pausedRun.nodeId}
              title={pausedNode?.name || "Review"}
              prompt={(pausedRun.signal as { prompt?: string } | null)?.prompt ?? "Approve to continue."}
            />
          )}

          {!pausedRun && selectedNode && statusByNode.get(selectedNode.id) && (
            <NodeRunDetail node={selectedNode} run={statusByNode.get(selectedNode.id)!} />
          )}
        </div>
      )}
    </div>
  );
}

function HumanGate({
  flowId,
  runId,
  nodeId,
  title,
  prompt,
}: {
  flowId: string;
  runId: string;
  nodeId: string;
  title: string;
  prompt: string;
}) {
  const [pending, setPending] = useState(false);
  const decide = (approved: boolean) => {
    setPending(true);
    void decideFlowStep(flowId, runId, nodeId, approved);
  };
  return (
    <div className="glass-edge glass pointer-events-auto w-80 rounded-xl p-3" style={{ boxShadow: "0 0 0 1px #e0a94a55, 0 0 26px -6px #e0a94a66" }}>
      <div className="flex items-center gap-2">
        <UserCheck className="h-4 w-4" style={{ color: "#e0a94a" }} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: "#e0a94a" }}>
          waiting
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-ink-dim">{prompt}</p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide(false)}
          className="flex-1 rounded-lg border border-flare/30 py-1.5 font-mono text-[11px] uppercase tracking-widest text-flare transition hover:bg-flare/10 disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide(true)}
          className="flex-1 rounded-lg border border-plasma/40 bg-plasma/10 py-1.5 font-mono text-[11px] uppercase tracking-widest text-plasma transition hover:bg-plasma/20 disabled:opacity-50"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function NodeRunDetail({ node, run }: { node: FlowNode; run: NodeRunView }) {
  const meta = metaFor(node.kind);
  const chose = (run.signal as { chose?: string } | null)?.chose;
  return (
    <div className="glass pointer-events-auto max-h-56 w-72 overflow-auto rounded-xl p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-md"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          <meta.Icon className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {node.name || meta.label}
        </span>
        <span
          className="font-mono text-[10px] uppercase tracking-widest"
          style={{ color: STATUS_RING[run.status] ?? "var(--color-ink-faint)" }}
        >
          {run.status}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
        <span>{fmtDur(run.startedAt, run.finishedAt) || "—"}</span>
        {chose && (
          <span>
            chose <span className="text-plasma">{chose}</span>
          </span>
        )}
      </div>
      {run.error && (
        <p className="mt-2 rounded-md bg-flare/10 px-2 py-1.5 text-[11px] text-flare">{run.error}</p>
      )}
      {run.report && (
        <p className="mt-2 whitespace-pre-wrap text-[11px] leading-snug text-ink-dim">
          {run.report.length > 600 ? `${run.report.slice(0, 600)}…` : run.report}
        </p>
      )}
    </div>
  );
}

function SaveBadge({ state }: { state: "idle" | "saving" | "saved" }) {
  if (state === "idle") return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
      {state === "saving" ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" /> saving
        </>
      ) : (
        <>
          <Check className="h-3 w-3 text-plasma-dim" /> saved
        </>
      )}
    </span>
  );
}

function NodeCard({
  node,
  agents,
  flows,
  selected,
  status,
  onDown,
  onPortDown,
}: {
  node: FlowNode;
  agents: AgentOption[];
  flows: FlowOption[];
  selected: boolean;
  status?: string;
  onDown: (e: RPointerEvent) => void;
  onPortDown: (e: RPointerEvent, from: string, fromPort: string) => void;
}) {
  const meta = metaFor(node.kind);
  const Icon = meta.Icon;
  const ports = outputPortsOf(node.kind, node.config);
  const ring = status ? STATUS_RING[status] : undefined;
  const dim = status === "skipped";
  const subtitle = subtitleFor(node, agents, flows);

  return (
    <div
      onPointerDown={onDown}
      className={cn(
        "absolute flex cursor-grab select-none flex-col justify-center rounded-xl border bg-[color-mix(in_oklab,var(--color-void)_82%,transparent)] px-3 shadow-lg backdrop-blur transition-[box-shadow]",
        selected ? "border-plasma/60" : "border-ink/10",
      )}
      style={{
        left: node.x ?? 0,
        top: node.y ?? 0,
        width: NODE_W,
        height: NODE_H,
        opacity: dim ? 0.45 : 1,
        boxShadow: ring
          ? `0 0 0 2px ${ring}, 0 0 20px -4px ${ring}`
          : undefined,
        animation:
          status === "running" || status === "paused"
            ? "pulse 1.4s ease-in-out infinite"
            : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-tight text-ink">
            {node.name || meta.label}
          </span>
          <span className="block truncate text-[11px] leading-tight text-ink-faint">
            {subtitle}
          </span>
        </span>
      </div>

      {/* input port */}
      {meta.hasInput && (
        <span className="absolute -left-[6px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-ink/30 bg-[var(--color-void)]" />
      )}
      {/* output port(s) */}
      {ports.map((label, i) => {
        const top = (NODE_H * (i + 1)) / (ports.length + 1);
        return (
          <span key={label || i} className="absolute -right-[6px] flex items-center" style={{ top, transform: "translateY(-50%)" }}>
            <span
              onPointerDown={(e) => onPortDown(e, node.id, label)}
              className="h-3 w-3 cursor-crosshair rounded-full border-2 border-plasma/50 bg-[var(--color-void)] transition hover:scale-125 hover:bg-plasma/40"
            />
            {meta.outPorts === "ports" && label && (
              <span className="ml-1 font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                {label}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function subtitleFor(node: FlowNode, agents: AgentOption[], flows: FlowOption[]): string {
  const cfg = node.config ?? {};
  if (node.kind === "agent") {
    const a = agents.find((x) => x.id === cfg.agentId);
    return a ? a.name : "no agent set";
  }
  if (node.kind === "branch" || node.kind === "filter")
    return (cfg.condition as string) || "no condition";
  if (node.kind === "subroutine" || node.kind === "loop") {
    const f = flows.find((x) => x.id === cfg.flowId);
    const name = f ? f.name : "no flow set";
    return node.kind === "loop" ? `${name} · per item` : name;
  }
  if (node.kind === "human") return (cfg.prompt as string) || "waits for you";
  if (node.kind === "output") return (cfg.tool as string) || "notify";
  return metaFor(node.kind).label.toLowerCase();
}
