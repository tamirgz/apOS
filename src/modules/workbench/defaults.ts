import type { TaskType } from "./schema";

/**
 * Leaf module — imported by the engine, the actions and the AI tools alike.
 *
 * These used to live in engine.ts, which made `actions → engine → native
 * adapter → tool-registry → registry.server → manifest.server → engine` a
 * cycle. It happened to work in the worker (nothing touches the exports at
 * import time) and in the Next bundler, but any other entry order throws
 * "Cannot access 'workbenchJobs' before initialization". Constants belong
 * somewhere that imports nothing.
 */
export const TIMEOUTS: Record<TaskType, number> = {
  research: 15 * 60_000,
  code: 25 * 60_000,
  // Local models are slower per token; give them room before we call it dead.
  "code-local": 40 * 60_000,
  docs: 10 * 60_000,
  custom: 20 * 60_000,
};

/** Task type → executor, unless the attempt names one (D6 defaults). */
export const TYPE_DEFAULT_EXECUTOR: Record<TaskType, string> = {
  research: "claude-headless",
  code: "claude-headless",
  // Droid won the local-executor benchmark: equal correctness to opencode/qwen
  // on the same nvfp4 model, ~2–2.5× faster. opencode/qwen stay selectable.
  "code-local": "droid",
  docs: "native",
  custom: "claude-headless",
};
