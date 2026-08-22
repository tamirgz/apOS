// Client-safe module contract: METADATA ONLY. No component imports here —
// this file is consumed by client components (sidebar, command bar), so any
// component referenced here would be pulled into the browser bundle.
// Components (routes, widgets) live in the server manifest (types.server.ts).
import type { LucideIcon } from "lucide-react";

export interface ModuleCommand {
  id: string;
  title: string;
  keywords: string[];
  /** Navigation target, e.g. "/m/tasks" or "/m/tasks/new". */
  href: string;
}

export interface ModuleManifest {
  /** Unique id — also the URL segment under /m/. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** CSS color used for nav glow / accent highlights. */
  accent: string;
  /**
   * Sidebar placement. `order` sorts the flat list (and within a group).
   * `group` pulls the item under a collapsible section label (e.g. "Sources"
   * for read-only external feeds) instead of the always-visible core list.
   * `external: true` marks a pointer-out — clicking ultimately opens the real
   * app — and shows an ↗ cue (Telegram is a source but readable in-app, so it
   * sets `group` without `external`).
   */
  nav: { order: number; group?: string; external?: boolean };
  /** ⌘K entries contributed by this module. */
  commands: ModuleCommand[];
  /**
   * When true, the ⌘K bar offers context-aware search of this module's content
   * while you're on its page — dispatched via `searchModule(id, query)`. Wire a
   * case there for the module before enabling this.
   */
  searchable?: boolean;
}
