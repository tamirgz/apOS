"use client";

import { useSyncExternalStore } from "react";

/**
 * Session-only feedback for what the user just did — never persisted, never a
 * notification. `done()` shows briefly in the top bar's status slot, `failed()`
 * also raises a corner toast; both land in the slot's "this session" list.
 *
 * `act()` is the one way a component runs a server action it wants feedback
 * for: it awaits the action, turns a throw OR a returned failure
 * (`{ ok: false, error | message | detail | reason }`, `{ error: "…" }`) into
 * `failed()`, and a success into `done()`. It never rethrows — inside a
 * transition a rethrow would take the page to the error boundary.
 */

export type FeedbackLevel = "done" | "info" | "error";

export interface FeedbackEntry {
  id: number;
  level: FeedbackLevel;
  title: string;
  body?: string;
  href?: string;
  at: number;
}

const MAX = 20;
/** How long a success line holds the status slot. */
const FLASH_MS = 2500;

export interface FeedbackState {
  /** Newest first, at most 20 — this browser tab's session only. */
  entries: FeedbackEntry[];
  /** The success/info line the status slot shows right now. */
  flash: FeedbackEntry | null;
  /** Errors since the list was last opened. */
  unseen: number;
}

let state: FeedbackState = { entries: [], flash: null, unseen: 0 };
let nextId = 1;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: Partial<FeedbackState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function emit(e: Omit<FeedbackEntry, "id" | "at">): FeedbackEntry {
  const entry = { ...e, id: nextId++, at: Date.now() };
  const entries = [entry, ...state.entries].slice(0, MAX);
  if (entry.level === "error") {
    set({ entries, unseen: state.unseen + 1 });
  } else {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => set({ flash: null }), FLASH_MS);
    set({ entries, flash: entry });
  }
  return entry;
}

export const done = (title: string, opts: { body?: string; href?: string } = {}) =>
  emit({ level: "done", title, ...opts });
export const info = (title: string, opts: { body?: string; href?: string } = {}) =>
  emit({ level: "info", title, ...opts });
export const failed = (title: string, body?: string) => emit({ level: "error", title, body });

/** The list was opened: its errors count as seen. */
export const markSeen = () => state.unseen && set({ unseen: 0 });

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => state;
const initial: FeedbackState = { entries: [], flash: null, unseen: 0 };

export function useFeedback(): FeedbackState {
  return useSyncExternalStore(subscribe, snapshot, () => initial);
}

/** Production builds replace a server action's thrown message with this. */
const REDACTED = /omitted in production builds|An error occurred in the Server Components render/i;

/** The failure a result object reports, or null when it reports success. */
export function resultError(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const text = [o.error, o.message, o.detail, o.reason].find((v) => typeof v === "string" && v.trim());
  if (o.ok === false) return (text as string | undefined) ?? "it didn't go through";
  return typeof o.error === "string" && o.error.trim() ? o.error : null;
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (REDACTED.test(msg)) return "the server hit an error — details are in the apOS log";
  return msg.replace(/^Error:\s*/, "").slice(0, 240);
}

type Msg<T> = string | ((result: T) => string | null | undefined);

export interface ActOptions<T> {
  /** Success line; omit when the UI already shows the result. */
  done?: Msg<T>;
  /** Where the success line links to. */
  href?: string | ((result: T) => string | undefined);
  /** Failure title, e.g. "Couldn't save the routine". Defaults to "Action failed". */
  failed?: string;
}

export type ActResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Run a server action with feedback. A failure is already reported when this
 * resolves, so callers only branch on `ok` for their own follow-up:
 * `if ((await act(...)).ok) close()`.
 */
export async function act<T>(fn: () => Promise<T>, opts: ActOptions<T> = {}): Promise<ActResult<T>> {
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) failed(opts.failed ?? "Action failed", errorText(e));
    return { ok: false };
  }
  const err = resultError(result);
  if (err) {
    failed(opts.failed ?? "Action failed", err);
    return { ok: false };
  }
  const title = typeof opts.done === "function" ? opts.done(result) : opts.done;
  if (title) {
    const href = typeof opts.href === "function" ? opts.href(result) : opts.href;
    done(title, { href });
  }
  return { ok: true, value: result };
}
