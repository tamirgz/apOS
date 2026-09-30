"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Plus } from "lucide-react";
import type { MemoryBlock, MemoryEntry } from "@/core/db/schema/memory";
import { cn } from "@/core/ui/cn";
import { act, errorText } from "@/core/ui/feedback";
import { createMemoryBlock, saveMemoryBlock } from "../actions";

const KIND_COLOR: Record<string, string> = {
  fact: "var(--color-ion)",
  decision: "var(--color-plasma)",
  lesson: "var(--color-solar)",
  event: "var(--color-violet)",
  superseded: "var(--color-ink-faint)",
};

function AddBlock() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const labelRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-dim transition hover:border-plasma/30 hover:text-plasma"
      >
        <Plus className="size-3" /> add block
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const label = labelRef.current?.value.trim();
        if (!label || pending) return;
        startTransition(async () => {
          const r = await act(() => createMemoryBlock(label, descRef.current?.value ?? ""), { failed: "Couldn't create the memory block" });
          if (!r.ok) return;
          setOpen(false);
        });
      }}
      className="glass flex flex-wrap items-center gap-2 rounded-xl p-3"
    >
      <input
        ref={labelRef}
        autoFocus
        placeholder="label (e.g. blokbox_context)"
        className="h-8 flex-1 rounded-lg border border-white/10 bg-abyss px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40"
      />
      <input
        ref={descRef}
        placeholder="what it holds"
        className="h-8 flex-1 rounded-lg border border-white/10 bg-abyss px-3 text-xs text-ink outline-none focus:border-plasma/40"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-plasma/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-plasma transition hover:bg-plasma/25 disabled:opacity-40"
      >
        create
      </button>
    </form>
  );
}

function BlockField({ block }: { block: MemoryBlock }) {
  const [value, setValue] = useState(block.value);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== block.value;

  return (
    <div className="glass rounded-xl p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-plasma">
          {block.label}
        </p>
        <p
          className={cn(
            "font-mono text-[9px] tabular-nums",
            value.length > block.charLimit ? "text-flare" : "text-ink-faint",
          )}
        >
          {value.length}/{block.charLimit}
        </p>
      </div>
      <p className="mb-1.5 text-xs text-ink-dim">{block.description}</p>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
          setError(null);
        }}
        rows={2}
        placeholder="(empty — chat and agents will fill this as they learn, or write it yourself)"
        className="w-full resize-y rounded-lg border border-white/8 bg-abyss/50 p-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-plasma/30"
      />
      {error && <p className="mt-1 font-mono text-[10px] text-flare">{error}</p>}
      <button
        type="button"
        disabled={!dirty || pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const r = await saveMemoryBlock(block.label, value);
              if (r) setError(r.error);
              else setSaved(true);
            } catch (e) {
              setError(errorText(e));
            }
          })
        }
        className={cn(
          "mt-1 flex items-center gap-1.5 rounded-lg px-4 py-1.5 font-mono text-[10px] uppercase tracking-widest transition",
          dirty
            ? "bg-plasma/15 text-plasma hover:bg-plasma/25"
            : "border border-white/8 text-ink-faint",
        )}
      >
        {saved ? <Check className="size-3" /> : null}
        {pending ? "saving…" : saved ? "saved" : "save"}
      </button>
    </div>
  );
}

export function MemoryEditor({
  blocks,
  journal,
  journalCount,
}: {
  blocks: MemoryBlock[];
  journal: MemoryEntry[];
  journalCount: number;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        persistent memory — injected into every AI call
      </p>
      {blocks.map((b) => (
        <BlockField key={b.label} block={b} />
      ))}
      <AddBlock />

      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        memory journal — {journalCount} archival entr
        {journalCount === 1 ? "y" : "ies"}, recalled on demand
      </p>
      <div className="glass rounded-xl p-3">
        {journal.length === 0 ? (
          <p className="py-2 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            empty — chat and agents store decisions/lessons here via
            memory.remember
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {journal.map((e) => (
              <li key={e.id} className="flex items-start gap-2.5">
                <span
                  className="mt-1 rounded-md border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-widest"
                  style={{
                    color: KIND_COLOR[e.kind],
                    borderColor: `color-mix(in oklab, ${KIND_COLOR[e.kind]} 35%, transparent)`,
                  }}
                >
                  {e.kind}
                </span>
                <span className="flex-1 text-xs leading-relaxed text-ink-dim">
                  {e.text.length > 160 ? e.text.slice(0, 160) + "…" : e.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
