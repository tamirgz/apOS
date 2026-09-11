/**
 * The commit relevance gate — the attention filter in front of a routine's
 * (possibly expensive) executor. A cheap/free model reads roughly what a commit
 * changed and rules on ONE thing: does it touch anything this routine's ask
 * cares about? If not, the executor never runs, so the expensive tier is spent
 * only on commits that plausibly matter.
 *
 * Configurable: per routine via `gateModel` (a free ollama tag), else the global
 * `routine.gate` route (default a free local model). The gate must stay free —
 * it runs on every commit.
 *
 * Fail-CLOSED (routine owner's choice): if it can't run or returns nonsense, it
 * SKIPS (relevant=false) to protect the expensive tier. A skip is logged, and a
 * manual "run now" always bypasses the gate.
 */
import { db } from "@/core/db/client";
import { ollamaProvider } from "@/core/ai/ollama";
import type { Routine } from "./queries";

export interface GateVerdict {
  relevant: boolean;
  why: string;
}

/**
 * File paths that never carry documentation impact. A commit touching ONLY
 * these is skipped for free (no model call) — this is the reliable half of the
 * gate; a small model can't judge semantics but it doesn't need to for these.
 */
const IRRELEVANT_PATH = [
  /(^|\/)(tests?|__tests__|spec)(\/|$)/i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /Test\.[a-z]+$/,
  /(^|\/)(build\.gradle|settings\.gradle|gradlew|gradle\.properties)/i,
  /\.gradle(\.kts)?$/i,
  /(^|\/)(libs\.versions\.toml|pom\.xml|Gemfile(\.lock)?|Makefile)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/i,
  /(^|\/)\.github\//i,
  /(^|\/)\.(gitignore|editorconfig|prettierrc|eslintrc|dockerignore)[a-z.]*$/i,
  /(^|\/)Dockerfile/i,
  /\.(png|jpe?g|gif|svg|webp|ico|ttf|woff2?|otf|eot|mp4|webm|lock)$/i,
];

/** True iff the commit touches only files that can't affect any docs. */
function deterministicSkip(files: string[]): boolean {
  if (files.length === 0) return false; // unknown → let the model decide
  return files.every((f) => IRRELEVANT_PATH.some((re) => re.test(f)));
}

export async function classifyCommitRelevance(
  routine: Pick<Routine, "prompt" | "gateModel">,
  diff: { files: string[]; patch: string },
): Promise<GateVerdict> {
  // Stage 0 — free deterministic filter: a commit of only tests/build/CI/asset
  // files has no documentation impact, so skip without spending the model.
  if (deterministicSkip(diff.files)) {
    return { relevant: false, why: "only build/test/asset files — no doc impact" };
  }
  // Resolve the gate brain: a per-routine override (a free ollama tag) beats the
  // global routine.gate route. Kept on the Ollama provider so it can't bill.
  let provider = ollamaProvider;
  let model: string;
  if (routine.gateModel?.trim()) {
    model = routine.gateModel.replace(/^ollama\//, "").trim();
  } else {
    const { resolveRoute } = await import("@/core/ai/routing");
    const route = await resolveRoute("routine.gate");
    provider = route.provider;
    model = route.model;
  }

  const system =
    "You are a fast relevance gate in front of an expensive documentation agent. " +
    "Given a code commit's changes and the STANDING TASK that agent performs, decide ONE thing: " +
    "could this commit plausibly change something the task's target documents describe — a capability, behavior, claim, data flow, or user-facing detail? " +
    "Answer YES only if a human keeping those docs honest would want to look. Answer NO for changes with no documentation impact: internal refactors, tests, formatting, build/CI, dependency bumps, comments, logging, or work in a subsystem the docs don't cover. " +
    "When unsure, lean NO — a cheap miss is cheaper than a needless expensive run. " +
    'Reply with ONLY compact JSON: {"relevant": true|false, "why": "<=10 words"}.';

  const fileList = diff.files.slice(0, 60).join("\n") || "(no files)";
  const body =
    `STANDING TASK:\n${routine.prompt.slice(0, 1200)}\n\n` +
    `COMMIT — CHANGED FILES:\n${fileList}\n\n` +
    `COMMIT — DIFF (truncated):\n${diff.patch.slice(0, 8000)}`;

  let out = "";
  try {
    for await (const ev of provider.run({
      system,
      // `/no_think` keeps a reasoning model fast for a yes/no; harmless elsewhere.
      messages: [{ role: "user", content: `/no_think\n${body}` }],
      tools: [],
      toolCtx: { db },
      model,
      maxTurns: 1,
      track: { source: "gate", label: "commit gate" },
    })) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "done" && ev.text) out = ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  } catch (e) {
    // Fail CLOSED: skip on error (protect the expensive tier), but say why.
    return {
      relevant: false,
      why: `gate error → skipped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 90),
    };
  }

  const m = out.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Partial<GateVerdict>;
      return { relevant: !!o.relevant, why: String(o.why ?? "").slice(0, 100) };
    } catch {
      /* fall through */
    }
  }
  // Unparseable → fail closed (skip).
  return { relevant: false, why: "gate returned no verdict → skipped" };
}
