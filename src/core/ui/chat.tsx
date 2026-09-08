"use client";

import {
  type ComponentType,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BookMarked,
  Check,
  FileDown,
  Sparkles,
  StickyNote,
  Trash2,
  Wrench,
} from "lucide-react";
import { createNote } from "@/modules/notes/actions";
import { saveMarkdownToVault } from "@/modules/obsidian/actions";
import { Markdown } from "./Markdown";
import { cn } from "./cn";

export type ChatEvent =
  | { type: "meta"; provider: string; model: string; chatRunId?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string }[];
  pending?: boolean;
  thinking?: boolean;
  error?: string;
  /** The persisted run backing this reply — lets a reopened chat reclaim the
   *  answer of a prompt that finished server-side after the client left. */
  chatRunId?: string;
}

/**
 * Shared chat engine + view, used by both the ⌘K command bar and the persistent
 * Investments panel. Pass a `storageKey` to persist the conversation across
 * reloads (localStorage); omit it for an ephemeral session.
 */
export function useChat(opts?: { storageKey?: string; route?: string }) {
  const key = opts?.storageKey;
  const routeKey = opts?.route;
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(
    null,
  );
  const loaded = useRef(false);

  // Load persisted history once, then reclaim any prompt that was still running
  // when the client last left: its run kept executing server-side, so poll the
  // run until it finishes and drop the answer back in.
  useEffect(() => {
    if (!key || loaded.current) return;
    loaded.current = true;
    let loadedTurns: ChatTurn[] = [];
    try {
      const raw = localStorage.getItem(key);
      if (raw) loadedTurns = JSON.parse(raw) as ChatTurn[];
    } catch {
      return; // corrupt storage
    }
    setTurns(loadedTurns);
    let cancelled = false;
    for (const t of loadedTurns) {
      if (t.role !== "assistant" || !t.pending || !t.chatRunId) continue;
      const runId = t.chatRunId;
      void (async () => {
        for (let tries = 0; tries < 240 && !cancelled; tries++) {
          try {
            const res = await fetch(`/api/chat/run/${runId}`);
            if (res.ok) {
              const r = (await res.json()) as {
                status: string;
                result: string | null;
                error: string | null;
              };
              if (r.status !== "running" && r.status !== "queued") {
                setTurns((prev) =>
                  prev.map((p) =>
                    p.chatRunId === runId
                      ? { ...p, content: r.result ?? p.content, error: r.error ?? undefined, pending: false }
                      : p,
                  ),
                );
                return;
              }
            }
          } catch {
            /* transient — retry */
          }
          await new Promise((rr) => setTimeout(rr, 2000));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Persist on change. Settled turns always; a still-running turn is kept ONLY
  // if it has a run id (so it can be reclaimed on return) — never a plain
  // spinner that would otherwise be stuck forever.
  useEffect(() => {
    if (!key || !loaded.current) return;
    try {
      const clean = turns
        .filter((t) => !t.pending || !!t.chatRunId)
        .map((t) => ({
          role: t.role,
          content: t.content,
          error: t.error,
          pending: t.pending,
          chatRunId: t.chatRunId,
        }));
      localStorage.setItem(key, JSON.stringify(clean.slice(-40)));
    } catch {
      // ignore quota
    }
  }, [turns, key]);

  const send = useCallback(
    async (text: string) => {
      // Cap resent history — long conversations otherwise grow token cost.
      const history = turns
        .filter((t) => !t.pending && !t.error)
        .map((t) => ({ role: t.role, content: t.content }))
        .slice(-12);
      const nextMessages = [...history, { role: "user" as const, content: text }];
      setTurns((t) => [
        ...t,
        { role: "user", content: text },
        { role: "assistant", content: "", pending: true, toolCalls: [] },
      ]);
      setBusy(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextMessages, route: routeKey }),
        });
        if (!res.ok || !res.body) throw new Error(`chat → ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ChatEvent;
            setTurns((prev) => {
              const next = [...prev];
              const cur = { ...next[next.length - 1] };
              if (event.type === "text" || event.type === "done") {
                if (event.text) cur.content = event.text;
                if (event.type === "done") cur.pending = false;
              } else if (event.type === "reasoning") {
                cur.thinking = true;
              } else if (event.type === "tool_call") {
                cur.toolCalls = [...(cur.toolCalls ?? []), { name: event.name }];
              } else if (event.type === "error") {
                cur.error = event.message;
                cur.pending = false;
              } else if (event.type === "meta" && event.chatRunId) {
                cur.chatRunId = event.chatRunId;
              }
              next[next.length - 1] = cur;
              return next;
            });
            if (event.type === "meta") setMeta(event);
          }
        }
      } catch (e) {
        setTurns((prev) => {
          const next = [...prev];
          const cur = { ...next[next.length - 1] };
          cur.error = String(e);
          cur.pending = false;
          next[next.length - 1] = cur;
          return next;
        });
      } finally {
        setBusy(false);
        setTurns((prev) =>
          prev.map((t, i) => (i === prev.length - 1 ? { ...t, pending: false } : t)),
        );
      }
    },
    [turns],
  );

  const reset = useCallback(() => {
    setTurns([]);
    if (key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }, [key]);

  // Delete one exchange: the turn at `index` plus, if it's a user prompt, its
  // assistant reply. The persistence effect saves the pruned history.
  const remove = useCallback((index: number) => {
    setTurns((prev) => {
      const next = [...prev];
      const count =
        next[index]?.role === "user" && next[index + 1]?.role === "assistant"
          ? 2
          : 1;
      next.splice(index, count);
      return next;
    });
  }, []);

  return { turns, busy, meta, send, reset, remove };
}

/** Title for a saved response: first meaningful line, stripped of markdown. */
function deriveTitle(content: string): string {
  const first =
    content
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const clean = first
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[|`>]/g, "")
    .trim();
  if (clean.length < 3 || /^[[{"]/.test(clean)) return "apOS chat note";
  return clean.slice(0, 70);
}

type ActionState = "idle" | "busy" | "done" | "error";

/** Save / export controls under an assistant response. */
function MessageActions({ content }: { content: string }) {
  const [note, setNote] = useState<ActionState>("idle");
  const [obs, setObs] = useState<ActionState>("idle");
  const [pdf, setPdf] = useState<ActionState>("idle");
  const title = deriveTitle(content);

  const flash = (set: (s: ActionState) => void, ok: boolean) => {
    set(ok ? "done" : "error");
    setTimeout(() => set("idle"), 1800);
  };

  const doNote = async () => {
    setNote("busy");
    try {
      await createNote({ title, body: content });
      flash(setNote, true);
    } catch {
      flash(setNote, false);
    }
  };
  const doObsidian = async () => {
    setObs("busy");
    try {
      const r = await saveMarkdownToVault({ title, body: content });
      flash(setObs, !!r.ok);
    } catch {
      flash(setObs, false);
    }
  };
  const doPdf = async () => {
    setPdf("busy");
    try {
      const res = await fetch("/api/chat/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (!res.ok) throw new Error("pdf failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aios-${
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "chat"
      }.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      flash(setPdf, true);
    } catch {
      flash(setPdf, false);
    }
  };

  const btn = (
    label: string,
    Icon: ComponentType<{ className?: string }>,
    state: ActionState,
    onClick: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "busy"}
      title={`Save as ${label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider transition disabled:opacity-50",
        state === "done"
          ? "text-plasma"
          : state === "error"
            ? "text-flare"
            : "text-ink-faint hover:bg-white/6 hover:text-ink",
      )}
    >
      {state === "done" ? <Check className="size-3" /> : <Icon className="size-3" />}
      {label}
    </button>
  );

  return (
    <div className="mt-1.5 flex items-center gap-0.5 border-t border-white/5 pt-1.5">
      {btn("note", StickyNote, note, doNote)}
      {btn("obsidian", BookMarked, obs, doObsidian)}
      {btn("pdf", FileDown, pdf, doPdf)}
    </div>
  );
}

/**
 * The chips log every tool the model invoked, so a tool called N times would
 * render N identical chips. Collapse them to one chip per tool (first-seen
 * order) with a ×N count when it repeated.
 */
function collapseToolCalls(
  calls: { name: string }[] | undefined,
): { name: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const c of calls ?? []) {
    if (!counts.has(c.name)) order.push(c.name);
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, count: counts.get(name)! }));
}

/** The scrollable message list (turns → bubbles). Auto-scrolls on new turns. */
export function ChatMessages({
  turns,
  emptyHint,
  className,
  onDelete,
}: {
  turns: ChatTurn[];
  emptyHint?: React.ReactNode;
  className?: string;
  /** Delete the exchange at this turn index (prompt + its reply). */
  onDelete?: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  return (
    <div ref={scrollRef} className={cn("flex-1 space-y-3 overflow-y-auto", className)}>
      {turns.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <Sparkles className="size-5 text-plasma" />
          <div className="text-sm text-ink-dim">
            {emptyHint ?? "Ask anything, or tell me to do something."}
          </div>
        </div>
      )}
      {turns.map((t, i) => (
        <div
          key={i}
          className={cn(
            "group flex items-start gap-1.5",
            t.role === "user" && "justify-end",
          )}
        >
          {t.role === "user" && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(i)}
              title="Delete this question and its answer"
              aria-label="Delete this question and its answer"
              // Always visible (dimmed), not hover-only — otherwise it's
              // unreachable on touch devices (no hover). Brightens on hover/focus.
              className="mt-1.5 shrink-0 rounded p-1 text-ink-faint opacity-50 transition hover:text-flare focus:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          <div
            className={cn(
              "rounded-xl px-3.5 py-2.5 text-sm leading-relaxed",
              t.role === "user"
                ? "max-w-[85%] bg-plasma/12 text-ink"
                : // Fill the row (not shrink-wrap to the text) so wide content —
                  // charts, tables — renders at full width instead of squashed
                  // into a narrow bubble.
                  "min-w-0 flex-1 overflow-x-auto glass text-ink-dim",
            )}
          >
            {collapseToolCalls(t.toolCalls).map((c) => (
              <span
                key={c.name}
                className="mb-1.5 mr-1.5 inline-flex items-center gap-1.5 rounded-md border border-ion/25 bg-ion/8 px-2 py-0.5 font-mono text-[10px] text-ion"
              >
                <Wrench className="size-3" />
                {c.name}
                {c.count > 1 && <span className="text-ion/60">×{c.count}</span>}
              </span>
            ))}
            {t.content &&
              (t.role === "assistant" ? (
                <div className="[&_p:last-child]:mb-0">
                  <Markdown>{t.content}</Markdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap">{t.content}</p>
              ))}
            {t.role === "assistant" && t.content && !t.pending && (
              <MessageActions content={t.content} />
            )}
            {t.pending && !t.content && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex gap-1">
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className="size-1.5 animate-pulse-soft rounded-full bg-plasma"
                      style={{ animationDelay: `${d * 0.25}s` }}
                    />
                  ))}
                </span>
                {t.thinking && (
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                    thinking…
                  </span>
                )}
              </span>
            )}
            {t.error && <p className="font-mono text-xs text-flare">{t.error}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
