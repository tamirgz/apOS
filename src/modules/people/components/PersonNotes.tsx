"use client";

import { useState, useTransition } from "react";
import { act } from "@/core/ui/feedback";
import { setPersonNotes } from "../actions";

export function PersonNotes({
  personId,
  initial,
}: {
  personId: string;
  initial: string | null;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [pending, start] = useTransition();
  const dirty = value.trim() !== saved.trim();

  return (
    <div className="glass rounded-xl p-3.5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        notes
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Context, what they care about, open threads…"
        rows={3}
        className="w-full resize-none rounded-lg bg-white/5 p-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:bg-white/8"
      />
      {dirty && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await act(() => setPersonNotes(personId, value), {
                  failed: "Couldn't save the notes",
                });
                if (!r.ok) return;
                setSaved(value);
              })
            }
            className="rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
          >
            {pending ? "saving…" : "save"}
          </button>
        </div>
      )}
    </div>
  );
}
