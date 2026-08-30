"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Send, Plus, RefreshCw, Trash2, Check, X, SlidersHorizontal, Search } from "lucide-react";
import { useLiveEvents } from "@/core/ui/useLiveEvents";
import {
  addChannel,
  deleteChannel,
  ingestNow,
  setChannelCriteria,
  setChannelEnabled,
} from "../actions";
import type { TelegramChannel, TelegramPost } from "../schema";

/**
 * Base text direction by the DOMINANT script, not by the first character.
 * `dir="auto"` keys off the first strong char, so a Hebrew post that opens with
 * an English acronym ("CISA מדווחת…") wrongly renders LTR. Count Hebrew vs Latin
 * letters and let the majority win; the browser's bidi algorithm still lays out
 * the embedded runs correctly within that base direction.
 */
function textDir(t: string): "rtl" | "ltr" {
  const heb = (t.match(/[֐-׿]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return heb > lat ? "rtl" : "ltr";
}

export function TelegramView({
  channels,
  activeUsername,
  posts,
}: {
  channels: TelegramChannel[];
  activeUsername: string | null;
  posts: TelegramPost[];
}) {
  useLiveEvents(["telegram_changed"]);
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(channels.length === 0);
  const [username, setUsername] = useState("");
  const [criteria, setCriteria] = useState("");
  const [days, setDays] = useState("14");
  // Inline per-channel relevance-criteria editing (structured include/exclude).
  const [editId, setEditId] = useState<string | null>(null);
  const [editInclude, setEditInclude] = useState("");
  const [editExclude, setEditExclude] = useState("");
  // Keyword search + a relevant-only filter over the shown posts.
  const [query, setQuery] = useState("");
  const [relevantOnly, setRelevantOnly] = useState(false);

  const relevant = posts.filter((p) => p.relevant === "yes");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <Send className="size-5 text-ion" />
        <h1 className="font-display text-2xl font-semibold text-ink">Telegram sources</h1>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          public channels · read-only · relevance-gated
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-ion/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/10"
        >
          <Plus className="size-3" /> add channel
        </button>
      </header>

      {open && (
        <div className="flex flex-col gap-2 rounded-2xl border border-ion/20 bg-void/40 p-4">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="channel — @RedXCyberSecurity or https://t.me/s/RedXCyberSecurity"
            className="rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm text-ink outline-none focus:border-ion/40"
          />
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={2}
            placeholder="What counts as relevant? e.g. Malicious links/URLs, phishing, smishing, QR-code attacks, malicious PDF/office/archive files, CDR — NoClick's domain."
            className="resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-ion/40"
          />
          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              backfill
            </label>
            <input
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-16 rounded-lg border border-white/8 bg-void/50 px-2 py-1.5 font-mono text-xs text-ink-dim outline-none"
            />
            <span className="font-mono text-[10px] text-ink-faint">days</span>
            <button
              type="button"
              disabled={pending || !username.trim() || criteria.trim().length < 10}
              onClick={() =>
                start(async () => {
                  await addChannel({ username, criteria, backfillDays: Number(days) || 14 });
                  setUsername("");
                  setOpen(false);
                })
              }
              className="ml-auto rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
            >
              add & backfill
            </button>
          </div>
        </div>
      )}

      {channels.length > 0 && (
        <div className="flex flex-col gap-2">
          {channels.map((c) => {
            const on = c.enabled === "true";
            const editingThis = editId === c.id;
            return (
              <div key={c.id} className="rounded-xl border border-white/6 bg-void/30">
                <div className="flex items-center gap-3 p-3">
                  <button
                    type="button"
                    onClick={() => start(async () => void (await setChannelEnabled(c.id, !on)))}
                    className={`size-2.5 shrink-0 rounded-full ${on ? "bg-plasma shadow-[0_0_8px_var(--color-plasma)]" : "bg-ink-faint/40"}`}
                    title={on ? "enabled" : "paused"}
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/m/telegram/${encodeURIComponent(c.username)}`}
                      className={`text-sm transition hover:text-ion ${c.username === activeUsername ? "text-ion" : "text-ink"}`}
                      title="Show this channel's feed"
                    >
                      @{c.username}
                    </Link>
                    <p className="truncate font-mono text-[9px] uppercase tracking-widest text-ink-faint">
                      cursor {c.lastSeenId ?? "—"} · {c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : "never run"}
                    </p>
                  </div>
                  <button
                    type="button"
                    title="Edit relevance criteria"
                    onClick={() => {
                      setEditId(editingThis ? null : c.id);
                      setEditInclude(c.criteria);
                      setEditExclude(c.exclude);
                    }}
                    className={`rounded-md p-1.5 transition hover:text-ion ${editingThis ? "text-ion" : "text-ink-faint"}`}
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => start(async () => void (await ingestNow(c.id)))}
                    title="Ingest now"
                    className="rounded-md p-1.5 text-ink-faint transition hover:text-ion"
                  >
                    <RefreshCw className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => start(async () => void (await deleteChannel(c.id)))}
                    className="rounded-md p-1.5 text-ink-faint transition hover:text-flare"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {editingThis ? (
                  <div className="flex flex-col gap-3 border-t border-white/6 p-3">
                    <p className="font-mono text-[9px] leading-relaxed text-ink-faint">
                      One topic per line. Keep each specific — the gate matches a
                      post's <span className="text-ink-dim">core subject</span> against these, so precise
                      lines mean fewer mistakes.
                    </p>
                    <div>
                      <label className="mb-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-plasma/80">
                        <Check className="size-2.5" /> relevant — a post's subject must be one of these
                      </label>
                      <textarea
                        value={editInclude}
                        onChange={(e) => setEditInclude(e.target.value)}
                        rows={5}
                        placeholder={"phishing (email, spear-phishing, whaling, BEC)\nsmishing (SMS)\nvishing (voice)\nqishing (QR-code)\nransomware\n1-click and zero-click attacks\nmalicious links / URLs"}
                        className="w-full resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-plasma/40"
                      />
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-flare/80">
                        <X className="size-2.5" /> not relevant — skip even if it's cybersecurity
                      </label>
                      <textarea
                        value={editExclude}
                        onChange={(e) => setEditExclude(e.target.value)}
                        rows={5}
                        placeholder={"server-side CVEs (RCE, SQL-injection, appliance bugs)\nOT / ICS attacks\nbreaches without the topics above\ncompany / funding / policy news\nhardware or AI-model news"}
                        className="w-full resize-y rounded-lg border border-white/8 bg-void/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-flare/40"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={
                          pending ||
                          editInclude.trim().length < 3 ||
                          (editInclude.trim() === c.criteria && editExclude.trim() === c.exclude)
                        }
                        onClick={() =>
                          start(async () => {
                            await setChannelCriteria(c.id, editInclude, editExclude);
                            setEditId(null);
                          })
                        }
                        className="flex items-center gap-1.5 rounded-lg bg-ion/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ion transition hover:bg-ion/25 disabled:opacity-40"
                      >
                        <Check className="size-3" /> save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditId(null)}
                        className="flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-faint transition hover:text-ink"
                      >
                        <X className="size-3" /> cancel
                      </button>
                      <span className="font-mono text-[9px] text-ink-faint">
                        applies on the next ingest
                      </span>
                    </div>
                  </div>
                ) : (
                  c.criteria && (
                    <p className="truncate border-t border-white/6 px-3 py-2 font-mono text-[9px] text-ink-faint">
                      gate: {c.criteria.split(/[\n;]+/).filter(Boolean).length} relevant ·{" "}
                      {c.exclude.split(/[\n;]+/).filter(Boolean).length} excluded topics
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeUsername && (
        <section>
          {/* Search + filter over the shown posts. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
            <div className="relative flex-1 min-w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search keywords in these posts…"
                className="w-full rounded-lg border border-white/8 bg-void/50 py-2 pl-9 pr-8 text-sm text-ink outline-none focus:border-ion/40"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint hover:text-ink"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setRelevantOnly((v) => !v)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-[10px] uppercase tracking-widest transition ${
                relevantOnly
                  ? "border-plasma/40 bg-plasma/15 text-plasma"
                  : "border-white/8 text-ink-faint hover:text-ink-dim"
              }`}
            >
              <Check className="size-3" /> relevant only
            </button>
          </div>

          {(() => {
            const q = query.trim().toLowerCase();
            const shown = posts.filter((p) => {
              if (relevantOnly && p.relevant !== "yes") return false;
              if (!q) return true;
              return (
                p.text.toLowerCase().includes(q) ||
                (p.relevanceWhy ?? "").toLowerCase().includes(q) ||
                (p.linkedText ?? "").toLowerCase().includes(q)
              );
            });
            return (
              <>
                <div className="mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.3em] text-ink-faint">
                  @{activeUsername} · showing {shown.length}
                  {shown.length !== posts.length ? ` of ${posts.length}` : ""} ·{" "}
                  {relevant.length} relevant
                </div>
                <div className="flex flex-col gap-2">
                  {shown.length === 0 && (
                    <p className="rounded-xl border border-white/6 bg-void/20 p-4 text-sm text-ink-faint">
                      No posts match “{query}”.
                    </p>
                  )}
                  {shown.map((p) => {
                    const yes = p.relevant === "yes";
                    return (
                      <div
                        key={p.id}
                        className={`rounded-xl border p-4 ${yes ? "border-plasma/25 bg-plasma/[0.04]" : "border-white/6 bg-void/20"}`}
                      >
                        <div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest">
                          {yes ? (
                            <span className="flex items-center gap-0.5 text-plasma"><Check className="size-2.5" /> relevant</span>
                          ) : (
                            <span className="flex items-center gap-0.5 text-ink-faint"><X className="size-2.5" /> skip</span>
                          )}
                          {p.relevanceWhy && (
                            <span dir="auto" className="text-ink-faint normal-case tracking-normal">· {p.relevanceWhy}</span>
                          )}
                          <span className="ml-auto shrink-0 text-ink-faint">
                            {p.postedAt ? new Date(p.postedAt).toLocaleString() : `#${p.postId}`}
                          </span>
                        </div>
                        {/* Base direction by dominant script (see textDir) so a
                            Hebrew post that opens with an English acronym still
                            reads right-to-left. Full text (no clamp) for reading. */}
                        <p
                          dir={textDir(p.text)}
                          className="whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]"
                        >
                          {p.text}
                        </p>
                        {p.urls.length > 0 && (
                          <div dir="ltr" className="mt-2 flex flex-col gap-0.5">
                            {p.urls.slice(0, 3).map((u) => (
                              <a
                                key={u}
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                                className="truncate font-mono text-[10px] text-ion/70 underline hover:text-ion"
                              >
                                {u}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
