import type { ProjectStatus } from "../schema";

/**
 * Chip styling per project status — mono uppercase micro-chips.
 * "paused" uses violet, distinct from the health chip's "at_risk" (solar) —
 * they used to collide since both were amber.
 */
export const STATUS_CHIP: Record<ProjectStatus, string> = {
  active: "border-plasma/30 bg-plasma/10 text-plasma",
  paused: "border-violet/30 bg-violet/10 text-violet",
  done: "border-ion/12 bg-ink/4 text-ink-faint",
  archived: "border-dashed border-ion/12 bg-ink/2 text-ink-faint/70",
};
