/**
 * Plane → apOS mapping. Pure (no I/O), so the whole translation is testable
 * against the saved fixture. Plane API v1 shapes: see __fixtures__/responses.json.
 */
import type { FeatureStatus } from "@/modules/projects/schema";
import type { TaskPriority, TaskStatus } from "../schema";

export interface PlanePage<T> {
  results: T[];
  next_cursor?: string | null;
  next_page_results?: boolean;
}
export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  description?: string | null;
  archived_at?: string | null;
}
export interface PlaneState {
  id: string;
  name: string;
  group: string;
}
export interface PlaneLabel {
  id: string;
  name: string;
}
export interface PlaneModule {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  target_date?: string | null;
  archived_at?: string | null;
}
export interface PlaneCycle {
  id: string;
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  archived_at?: string | null;
}
export interface PlaneWorkItem {
  id: string;
  name: string;
  description_html?: string | null;
  priority?: string | null;
  sequence_id?: number | null;
  state?: string | null;
  labels?: (string | { id: string; name?: string })[];
  parent?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  completed_at?: string | null;
  archived_at?: string | null;
  is_draft?: boolean;
  created_at?: string | null;
}

/**
 * State group → our state. Plane's "started" group holds both "In Progress"
 * and "In Review"-style states, so a started state whose NAME says review
 * maps to review.
 */
export function mapState(state: PlaneState | undefined): TaskStatus {
  switch (state?.group) {
    case "backlog":
      return "backlog";
    case "unstarted":
    case "triage":
      return "todo";
    case "started":
      return /review|qa|testing|verify/i.test(state.name) ? "review" : "doing";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "todo";
  }
}

export function mapPriority(p: string | null | undefined): TaskPriority {
  return p === "urgent" || p === "high" || p === "low" ? p : "medium";
}

/** Module status → feature status (Plane has used both "in-progress" and "in_progress"). */
export function mapModuleStatus(s: string | null | undefined): FeatureStatus {
  switch ((s ?? "").replace("_", "-")) {
    case "in-progress":
      return "active";
    case "paused":
      return "paused";
    case "completed":
      return "shipped";
    case "cancelled":
      return "cancelled";
    default:
      return "planned";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** description_html → readable plain text (lists become "- " lines). */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/ul|\/ol)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/\n+- /g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  return text || null;
}

/** A Plane date ("2026-10-01" or an ISO datetime) → Date, or null. */
export function planeDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function labelNames(item: PlaneWorkItem, labels: Map<string, string>): string[] {
  return (item.labels ?? [])
    .map((l) => (typeof l === "string" ? labels.get(l) : (l.name ?? labels.get(l.id))))
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase().replace(/\s+/g, "-"));
}
