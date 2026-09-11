/**
 * The delegation judge (A2 · Trust).
 *
 * After a delegated attempt reports success, this is the second pair of eyes:
 * it reads the ORIGINAL ask and WHAT CAME BACK and rules on one question only —
 * does the result genuinely satisfy the ask? It is deliberately strict, but it
 * judges each task type on its own terms (a research deliverable is prose, not a
 * diff) and never invents requirements the ask didn't make.
 *
 * Both brains are configurable in Settings (AI Routing):
 *   - "workbench.judge"          — the PRIMARY judge. A free LOCAL model by
 *     default, so verification never bills and never depends on a rate-limited
 *     cloud plan.
 *   - "workbench.judge.fallback" — used only when the primary can't run (down,
 *     Ollama not up…). An ONLINE model by default, as a safety net.
 * Only if BOTH fail does it report that it could not run (`errored`), so the
 * engine releases the result for the user's own review instead of faking a fail.
 */
import { db } from "@/core/db/client";
import type { AIProvider } from "@/core/ai/provider";

export interface JudgeVerdict {
  pass: boolean;
  score: number; // 0–100, how completely the result meets the ask
  gaps: string[]; // concrete, actionable misses (empty on a clean pass)
  rationale: string; // one honest paragraph
  attemptSeq?: number;
  /** True when the judge could not RUN at all (infra), not a content verdict. */
  errored?: boolean;
}

export interface JudgeInput {
  ask: string;
  result: string | null;
  changedFiles: string[]; // paths the attempt actually touched
  patch?: string | null; // truncated unified diff, when there is one
  taskType: string;
}

const CODE_SYSTEM =
  "You are a strict delivery judge for delegated ENGINEERING work. You compare a task's ASK to what an agent PRODUCED and rule on one thing only: does the produced result genuinely satisfy the ask? " +
  "Be adversarial and literal. A scaffold, stub, placeholder, TODO, 'framework in place', or a description of what a solution WOULD do is NOT satisfying a 'do X' ask — that is a FAIL. Work done on the wrong files, or a claim of changes the diff does not show, is a FAIL. " +
  "Only pass when the concrete deliverable the ask names actually exists in the result or the changed files. Do not be charitable; the whole point of you is to catch confident-but-empty output.";

const WRITTEN_SYSTEM =
  "You are a strict delivery judge for delegated RESEARCH and WRITING. You compare the ASK to what was PRODUCED and rule on one thing only: does the written deliverable genuinely and completely answer the ask? " +
  "There are no files or diffs to check — judge the writing on its own terms. Be adversarial about completeness, accuracy and specificity: a vague, generic, partial, or evasive answer is a FAIL; a thorough, concrete, on-point one is a PASS. " +
  "Judge ONLY against what the ask actually requested — do not invent extra requirements, and do not fail good work for missing things the ask never asked for.";

/** Judge tasks whose deliverable is prose (not code) on their own terms. */
function isWritten(taskType: string): boolean {
  return taskType === "research" || taskType === "docs" || taskType === "custom";
}

function buildPrompt(input: JudgeInput): { system: string; user: string } {
  const written = isWritten(input.taskType);
  const system = written ? WRITTEN_SYSTEM : CODE_SYSTEM;

  const producedText = (input.result ?? "(the agent returned no text)").slice(0, 16000);

  if (written) {
    const user =
      `THE ASK (${input.taskType}):\n${input.ask}\n\n` +
      `WHAT THE AGENT PRODUCED:\n${producedText}\n\n` +
      "Rule on whether this fully and accurately answers the ask. Respond with ONLY a JSON object: " +
      `{"pass": boolean, "score": 0-100, "gaps": string[], "rationale": string}. ` +
      "gaps must be concrete and actionable — what is missing or wrong — and empty only on a clean pass.";
    return { system, user };
  }

  const changed =
    input.changedFiles.length > 0
      ? input.changedFiles.join("\n")
      : "(the attempt changed no files)";
  const patch = input.patch ? `\n\nUNIFIED DIFF (truncated):\n${input.patch.slice(0, 12000)}` : "";
  // A zero-diff code run is not automatically a fail — some asks are conditional.
  const noChangeGuidance =
    input.changedFiles.length === 0
      ? "\n\nTHIS RUN CHANGED NO FILES. If the ask is CONDITIONAL (e.g. \"update X IF the change affects it\", \"keep docs in sync\"), a deliberate NO-CHANGE is a valid PASS — but ONLY if the result shows the agent genuinely did the work: it names what it actually inspected (the specific commit/diff, the specific target files or sections) and gives a concrete, verifiable reason nothing needs updating. If the result is vague, generic, empty, or shows no real inspection, it FAILED (the agent fizzled) — do NOT pass it. If the ask UNCONDITIONALLY required a change and none was made, FAIL."
      : "";
  const user =
    `THE ASK (${input.taskType}):\n${input.ask}\n\n` +
    `WHAT THE AGENT PRODUCED (its final result text):\n${producedText}\n\n` +
    `FILES THE AGENT ACTUALLY CHANGED:\n${changed}${patch}${noChangeGuidance}\n\n` +
    "Rule on whether the produced result satisfies the ask. Respond with ONLY a JSON object: " +
    `{"pass": boolean, "score": 0-100, "gaps": string[], "rationale": string}. ` +
    "gaps must be concrete and actionable — what is missing or wrong — and empty only on a clean pass.";
  return { system, user };
}

/** Pull the JSON verdict out of the model's reply, tolerant of prose/fences. */
function parseVerdict(text: string): JudgeVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]) as Partial<JudgeVerdict>;
      return {
        pass: !!o.pass,
        score: typeof o.score === "number" ? o.score : o.pass ? 100 : 0,
        gaps: Array.isArray(o.gaps) ? o.gaps.map(String).slice(0, 12) : [],
        rationale: String(o.rationale ?? "").slice(0, 1500),
      };
    } catch {
      // fall through to the conservative default
    }
  }
  return {
    pass: false,
    score: 0,
    gaps: ["The judge did not return a readable verdict."],
    rationale: text.slice(0, 800) || "No verdict returned.",
  };
}

/** Run one judge pass on a given provider/model. Throws on a provider error. */
async function runOnce(
  provider: AIProvider,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  let text = "";
  for await (const ev of provider.run({
    system,
    messages: [{ role: "user", content: user }],
    tools: [],
    toolCtx: { db },
    model,
    maxTurns: 1,
    track: { source: "workbench", label: "judge" },
  })) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "done" && ev.text) text = ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return text;
}

/**
 * Run the judge for one attempt. Never throws. Tries the routed brain first;
 * on an infra error (rate limit, network) falls back to a free local model; if
 * BOTH fail, returns an `errored` verdict — the caller releases the result for
 * the user's own review rather than pretending it passed or failed.
 */
export async function judgeAttempt(input: JudgeInput): Promise<JudgeVerdict> {
  const { system, user } = buildPrompt(input);
  const { resolveRoute } = await import("@/core/ai/routing");

  // 1) The PRIMARY judge (Settings → workbench.judge) — a free local model by
  //    default, so verification never bills and never hits a cloud rate limit.
  let primaryErr: unknown;
  try {
    const route = await resolveRoute("workbench.judge");
    return parseVerdict(await runOnce(route.provider, route.model, system, user));
  } catch (e) {
    primaryErr = e;
  }

  // 2) The FALLBACK judge (Settings → workbench.judge.fallback) — an online
  //    model, used only when the local one couldn't run (e.g. Ollama down).
  try {
    const route = await resolveRoute("workbench.judge.fallback");
    const v = parseVerdict(await runOnce(route.provider, route.model, system, user));
    const why = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    v.rationale = `[Primary judge unavailable (${why}); verified by the ${route.model} fallback instead.]\n${v.rationale}`;
    return v;
  } catch (fallbackErr) {
    // 3) Neither could run. NOT a content verdict — flag it so the engine
    //    releases the result for manual review instead of retrying.
    const why = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    const why2 = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    return {
      pass: false,
      score: 0,
      errored: true,
      gaps: ["The verifying judge could not run."],
      rationale: `The result was NOT graded — the judge could not run (primary: ${why}; fallback: ${why2}). Review it yourself and release when satisfied.`,
    };
  }
}
