"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import {
  CornerDownLeft,
  Inbox,
  LayoutGrid,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { modules } from "@/modules/registry";
import { captureToInbox } from "@/modules/inbox/actions";
import { createTask } from "@/modules/tasks/actions";
import { createNote } from "@/modules/notes/actions";
import { searchEverywhere, searchModule } from "@/core/search/commandSearch";
import type { CommandSearchHit } from "@/core/search/types";
import { ChatMessages, useChat } from "./chat";
import { cn } from "./cn";

/** Deterministic fast path: recognized prefixes skip the LLM and hit CRUD
 *  server actions directly — sub-second, zero tokens. */
/** Which module's icon/accent represents each index kind in the palette. */
const KIND_MODULE: Record<string, string> = {
  task: "tasks",
  note: "notes",
  idea: "ideas",
  project: "projects",
  feature: "projects",
  file: "projects",
  person: "people",
  knowledge: "knowledge",
  inbox: "inbox",
  workbench: "workbench",
  event: "calendar",
  ask: "ask",
  report: "agents",
  telegram: "telegram",
  mail: "gmail",
  vault: "vault",
  notion: "notion",
  memory: "settings",
  attention: "today",
};

function parseFastPath(search: string) {
  const task = search.match(/^(?:task|todo|t):\s*(.+)$/i);
  if (task) return { kind: "task" as const, text: task[1].trim() };
  const note = search.match(/^(?:note|n):\s*(.+)$/i);
  if (note) return { kind: "note" as const, text: note[1].trim() };
  return null;
}



function ChatView({
  chat,
  onExit,
}: {
  chat: ReturnType<typeof useChat>;
  onExit: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-[min(26.25rem,72vh)] flex-col">
      <ChatMessages
        turns={chat.turns}
        onDelete={chat.remove}
        className="px-4 py-3"
        emptyHint={
          <>
            Ask anything, or tell me to do something —<br />
            <span className="text-ink-faint">
              “create a task to renew the domain”, “what’s in my pipeline?”
            </span>
          </>
        }
      />
      <form
        className="flex items-center gap-2 border-t border-white/6 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          const v = inputRef.current?.value.trim();
          if (!v || chat.busy) return;
          chat.send(v);
          if (inputRef.current) inputRef.current.value = "";
        }}
      >
        <Sparkles className="size-4 shrink-0 text-plasma" />
        <input
          ref={inputRef}
          autoFocus
          placeholder={chat.busy ? "thinking…" : "Message the AI core…"}
          className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={chat.busy}
          className="rounded-lg bg-plasma/15 p-2 text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
          title="Send"
        >
          <CornerDownLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg p-2 text-ink-faint transition hover:bg-white/6 hover:text-ink"
          title="Back to commands"
        >
          <X className="size-4" />
        </button>
      </form>
      {chat.meta && (
        <p className="border-t border-white/4 px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
          via {chat.meta.provider} · {chat.meta.model}
        </p>
      )}
    </div>
  );
}

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"commands" | "chat">("commands");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<CommandSearchHit[]>([]);
  const [everywhere, setEverywhere] = useState<
    (CommandSearchHit & { kind: string })[]
  >([]);
  const router = useRouter();
  const pathname = usePathname();
  const chat = useChat();

  // Context-aware search: on a searchable module's page, ⌘K searches that
  // module's own content. `/m/knowledge` and `/m/knowledge/<id>` → knowledge.
  const activeModule = useMemo(() => {
    const id = pathname?.match(/^\/m\/([^/]+)/)?.[1];
    return id ? modules.find((m) => m.id === id && m.searchable) : undefined;
  }, [pathname]);

  useEffect(() => {
    const term = search.trim();
    if (!open || !term) {
      setResults([]);
      setEverywhere([]);
      return;
    }
    const id = activeModule?.id;
    const t = setTimeout(async () => {
      // Module-scoped hits first (when on a searchable module page), plus the
      // whole corpus — so ⌘K finds things from the dashboard/Today/settings too.
      const [mod, all] = await Promise.all([
        id ? searchModule(id, term).catch(() => []) : Promise.resolve([]),
        searchEverywhere(term).catch(() => []),
      ]);
      setResults(mod);
      // Don't repeat what the module section already shows.
      const seen = new Set(mod.map((r) => r.id));
      setEverywhere(all.filter((r) => !seen.has(r.id)).slice(0, 6));
    }, 180);
    return () => clearTimeout(t);
  }, [open, activeModule, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        // Close on Escape. Handled here on a native window listener (not on the
        // dialog): cmdk stops React's synthetic event propagation, so a handler
        // on the dialog never sees Escape, but the native event reaches window.
        // Unconditional close is a harmless no-op when already closed.
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("aios:commandbar", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("aios:commandbar", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setMode("commands");
      setSearch("");
    }
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const fast = parseFastPath(search);
  const runFast = async () => {
    if (!fast) return;
    if (fast.kind === "task") await createTask({ title: fast.text });
    else await createNote({ title: fast.text });
    setOpen(false);
    router.refresh();
  };
  const runCapture = async () => {
    if (!search.trim()) return;
    await captureToInbox(search.trim());
    setOpen(false);
    router.refresh();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-void/60 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 480, damping: 38 }}
            className={cn(
              "glass glass-edge w-full overflow-hidden rounded-2xl",
              mode === "chat" ? "max-w-3xl" : "max-w-xl",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {mode === "chat" ? (
              <ChatView chat={chat} onExit={() => setMode("commands")} />
            ) : (
              <Command label="Command bar" shouldFilter>
                <div className="flex items-center gap-2 border-b border-white/6 px-4">
                  <LayoutGrid className="size-4 text-ink-faint" />
                  <Command.Input
                    value={search}
                    onValueChange={setSearch}
                    autoFocus
                    placeholder="Type a command, or ask the AI…"
                    className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
                  />
                  <kbd className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
                    esc
                  </kbd>
                </div>
                <Command.List className="max-h-80 overflow-y-auto p-2">
                  <Command.Empty className="px-3 py-6 text-center font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                    no matching commands — try asking the AI
                  </Command.Empty>

                  {fast && (
                    <Command.Item
                      value={`fast ${search}`}
                      forceMount
                      onSelect={runFast}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink transition data-[selected=true]:bg-solar/10"
                    >
                      <Zap className="size-4 text-solar" />
                      <span>
                        {fast.kind === "task" ? "New task" : "New note"}{" "}
                        <span className="text-ink-dim">“{fast.text}”</span>
                      </span>
                      <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-solar">
                        instant
                      </span>
                    </Command.Item>
                  )}

                  {search.trim() && !fast && (
                    <Command.Item
                      value={`capture ${search}`}
                      forceMount
                      onSelect={runCapture}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink transition data-[selected=true]:bg-solar/10"
                    >
                      <Inbox className="size-4 text-solar" />
                      <span>
                        Capture to Inbox{" "}
                        <span className="text-ink-dim">
                          “{search.trim().slice(0, 40)}
                          {search.trim().length > 40 ? "…" : ""}”
                        </span>
                      </span>
                      <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                        ai files it
                      </span>
                    </Command.Item>
                  )}

                  <Command.Item
                    value={`ask-ai ${search}`}
                    forceMount
                    onSelect={() => {
                      setMode("chat");
                      if (search.trim()) chat.send(search.trim());
                    }}
                    className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink transition data-[selected=true]:bg-plasma/10"
                  >
                    <Sparkles className="size-4 text-plasma" />
                    <span>
                      Ask AI{" "}
                      {search.trim() && (
                        <span className="text-ink-dim">“{search.trim()}”</span>
                      )}
                    </span>
                    <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                      chat
                    </span>
                  </Command.Item>

                  {/* Context results are rendered as TOP-LEVEL items, not in a
                      Command.Group: cmdk hides a whole group when it thinks the
                      group has no matching items, and because these arrive
                      asynchronously (after the server call), cmdk had already
                      marked an empty group hidden and doesn't re-evaluate it. As
                      top-level items — like Ask AI — each shows on its own, and
                      folding the query into `value` keeps them past the filter. */}
                  {activeModule && results.length > 0 && (
                    <>
                      <div className="mt-1 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
                        In {activeModule.title}
                      </div>
                      {results.map((r) => {
                        const Icon = activeModule.icon;
                        return (
                          <Command.Item
                            key={r.id}
                            value={`${search} ${r.title} ${r.id}`}
                            forceMount
                            onSelect={() => go(r.href)}
                            className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-dim transition data-[selected=true]:bg-white/6 data-[selected=true]:text-ink"
                          >
                            <Icon
                              className="size-4 shrink-0"
                              style={{ color: activeModule.accent }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ink">
                                {r.title}
                              </span>
                              {r.subtitle && (
                                <span className="block truncate text-xs text-ink-faint">
                                  {r.subtitle}
                                </span>
                              )}
                            </span>
                          </Command.Item>
                        );
                      })}
                    </>
                  )}

                  {/* Same top-level-item rule as the module section above. */}
                  {everywhere.length > 0 && (
                    <>
                      <div className="mt-1 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-ink-faint">
                        Everywhere
                      </div>
                      {everywhere.map((r) => {
                        const mod = modules.find(
                          (m) => m.id === KIND_MODULE[r.kind],
                        );
                        const Icon = mod?.icon ?? LayoutGrid;
                        return (
                          <Command.Item
                            key={`ev-${r.kind}-${r.id}`}
                            value={`${search} ${r.title} ${r.kind} ${r.id}`}
                            forceMount
                            onSelect={() => go(r.href)}
                            className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-dim transition data-[selected=true]:bg-white/6 data-[selected=true]:text-ink"
                          >
                            <Icon
                              className="size-4 shrink-0"
                              style={mod ? { color: mod.accent } : undefined}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ink">
                                {r.title}
                              </span>
                              {r.subtitle && (
                                <span className="block truncate text-xs text-ink-faint">
                                  {r.subtitle}
                                </span>
                              )}
                            </span>
                            <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                              {r.kind}
                            </span>
                          </Command.Item>
                        );
                      })}
                    </>
                  )}

                  <Command.Group
                    heading="Navigate"
                    className="mt-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.25em] [&_[cmdk-group-heading]]:text-ink-faint"
                  >
                    <Command.Item
                      value="deck dashboard widgets overview"
                      onSelect={() => go("/deck")}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-dim transition data-[selected=true]:bg-white/6 data-[selected=true]:text-ink"
                    >
                      <LayoutGrid className="size-4" />
                      Deck
                    </Command.Item>
                    {modules.flatMap((m) =>
                      m.commands.map((c) => {
                        const Icon = m.icon;
                        return (
                          <Command.Item
                            key={c.id}
                            value={`${c.title} ${c.keywords.join(" ")}`}
                            onSelect={() => go(c.href)}
                            className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink-dim transition data-[selected=true]:bg-white/6 data-[selected=true]:text-ink"
                          >
                            <Icon
                              className="size-4"
                              style={{ color: m.accent }}
                            />
                            {c.title}
                            <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                              {m.id}
                            </span>
                          </Command.Item>
                        );
                      }),
                    )}
                  </Command.Group>
                </Command.List>
              </Command>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
