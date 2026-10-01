// Worker-safe (no "use server", no next/cache): imported by both the read
// query and the agent tool. The heuristic is deliberately deterministic so a
// project shows a health with zero agent runs — the Project-pulse agent then
// overwrites it with a nuanced judgement (and the only source of "blocked").
import type { ProjectHealth, ProjectStatus } from "./schema";

const DAY = 24 * 60 * 60 * 1000;

/** Presentation metadata per health — label + accent token + dot color. */
export const HEALTH_META: Record<
  ProjectHealth,
  { label: string; chip: string; accent: string }
> = {
  on_track: {
    label: "on track",
    chip: "border-plasma/30 bg-plasma/10 text-plasma",
    accent: "var(--color-plasma)",
  },
  at_risk: {
    label: "at risk",
    chip: "border-solar/30 bg-solar/10 text-solar",
    accent: "var(--color-solar)",
  },
  stalled: {
    label: "stalled",
    chip: "border-flare/30 bg-flare/10 text-flare",
    accent: "var(--color-flare)",
  },
  blocked: {
    label: "blocked",
    chip: "border-flare/40 bg-flare/15 text-flare",
    accent: "var(--color-flare)",
  },
};

/** How long the agent's stored health is trusted before the heuristic wins. */
export const HEALTH_STALE_DAYS = 10;

export interface HealthSignals {
  status: ProjectStatus;
  goal: string | null;
  nextAction: string | null;
  lastActivityAt: Date | null;
  overdue: number;
  openTasks: number;
}

/**
 * Read-time heuristic. Only meaningful for active projects — paused/done keep
 * a neutral "on_track" so they don't nag. Order matters: stalled ⊃ at_risk.
 */
export function deriveHealth(s: HealthSignals): {
  health: ProjectHealth;
  reason: string;
} {
  if (s.status !== "active") {
    return { health: "on_track", reason: `${s.status}` };
  }

  const ageDays = s.lastActivityAt
    ? Math.floor((Date.now() - s.lastActivityAt.getTime()) / DAY)
    : null;

  if (ageDays === null || ageDays >= 14) {
    return {
      health: "stalled",
      reason:
        ageDays === null ? "no activity yet" : `no activity in ${ageDays}d`,
    };
  }
  if (s.overdue > 0) {
    return {
      health: "at_risk",
      reason: `${s.overdue} overdue task${s.overdue > 1 ? "s" : ""}`,
    };
  }
  if (!s.nextAction) {
    return { health: "at_risk", reason: "no next action" };
  }
  if (!s.goal) {
    return { health: "at_risk", reason: "no goal set" };
  }
  if (ageDays >= 7) {
    return { health: "at_risk", reason: `quiet for ${ageDays}d` };
  }
  return { health: "on_track", reason: `active ${ageDays}d ago` };
}

/**
 * Resolve the health to show: the agent's stored judgement while it's fresh,
 * otherwise the live heuristic. Keeps the cockpit honest when the agent hasn't
 * run for a while instead of showing a stale "on_track".
 */
export function resolveHealth(
  stored: ProjectHealth | null,
  storedReason: string | null,
  healthUpdatedAt: Date | null,
  signals: HealthSignals,
  healthBy: "agent" | "user" | null = null,
): { health: ProjectHealth; reason: string; source: "agent" | "derived" } {
  const fresh =
    stored &&
    healthUpdatedAt &&
    Date.now() - healthUpdatedAt.getTime() < HEALTH_STALE_DAYS * DAY;
  // A judgement written BEFORE the project's latest activity may describe a
  // project that no longer exists (e.g. "no open tasks" read hours before an
  // import added 500). Only the USER's "blocked" survives — the heuristic can't
  // see an external wait, but an agent's "blocked" is a guess, and on
  // 2026-10-01 a local model invented one to get past the card guard; it then
  // stuck for days on a project that was busy every hour.
  const overtaken =
    !!healthUpdatedAt &&
    !!signals.lastActivityAt &&
    signals.lastActivityAt.getTime() > healthUpdatedAt.getTime() &&
    !(stored === "blocked" && healthBy === "user");
  if (fresh && !overtaken) {
    return {
      health: stored!,
      reason: storedReason ?? HEALTH_META[stored!].label,
      source: "agent",
    };
  }
  const d = deriveHealth(signals);
  return { ...d, source: "derived" };
}
