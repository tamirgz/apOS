"use client";

import { useEffect, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { cn } from "@/core/ui/cn";
import { act } from "@/core/ui/feedback";
import { saveIntegration } from "../actions";

export function EmbeddingModelPicker({ initial }: { initial: string }) {
  const [model, setModel] = useState(initial);
  const [models, setModels] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/ai/models?provider=ollama")
      .then((r) => r.json())
      .then((d: { models?: string[] }) => setModels(d.models ?? []))
      // A background load, not an action: Ollama being down shows as an empty
      // list, not a toast on every visit to Settings.
      .catch(() => {});
  }, []);

  const dirty = model !== initial;

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
        semantic search — offline embeddings
      </p>
      <div className="glass rounded-xl p-3">
        <p className="text-sm text-ink">
          Embedding model{" "}
          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-faint">
            local ollama
          </span>
        </p>
        <p className="mb-2 text-xs leading-snug text-ink-dim">
          Powers search.everything and the related-panels, fully offline.
          Pick an <em>embedding</em> model (nomic-embed-text, bge-m3, …) — chat
          models won&apos;t work.{" "}
          <span className="text-solar">
            Changing it wipes and rebuilds every stored embedding.
          </span>
        </p>
        <div className="flex gap-2">
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-abyss px-3 font-mono text-xs text-ink outline-none focus:border-plasma/40"
          >
            {model && !models.includes(model) && (
              <option value={model}>{model}</option>
            )}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!dirty || pending}
            onClick={() =>
              startTransition(async () => {
                const r = await act(() => saveIntegration("embedding_model", model), { failed: "Couldn't save the embedding model" });
                if (!r.ok) return;
                setSaved(true);
              })
            }
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-lg px-4 font-mono text-[11px] uppercase tracking-widest transition",
              dirty && !saved
                ? "bg-plasma/15 text-plasma hover:bg-plasma/25"
                : "border border-white/8 text-ink-faint",
            )}
          >
            {saved ? <Check className="size-3.5" /> : null}
            {pending ? "saving…" : saved ? "saved" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}
