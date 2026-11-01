/**
 * Post-handling audit for inbox triage.
 *
 * After the triage job routes a capture (into a task / note / idea / knowledge,
 * or deliberately leaves pure noise alone), a LOCAL LLM re-reads the original
 * capture and what triage actually did, and judges whether it was handled
 * PROPERLY. Pass → the item moves to "completed"; fail → "failed" (where it
 * stays visible for the user to fix). Free/local (qwen), never Claude.
 *
 * Fail-OPEN on the verifier's own trouble: if the model is unreachable or
 * returns garbage we can't parse, we don't punish a good triage — the item is
 * marked completed. Only a clear "no" from the model marks it failed.
 * Model: the "inbox.verify" route (Settings → AI Routing).
 */
import { completeText } from "@/core/ai/routing";

export interface HandlingVerdict {
  ok: boolean;
  note: string;
}

/**
 * Audit one handled capture. `handling` is a short human description of what
 * triage did (e.g. `Filed as Task — "Call the lawyer Tuesday"` or
 * `Left in the inbox — judged pure noise`).
 */
export async function verifyHandling(
  input: string,
  handling: string,
): Promise<HandlingVerdict> {
  const system =
    "You audit an inbox triage. You are given a raw captured note and how an AI assistant handled it (filed it into a destination, or deliberately left it alone). Decide whether it was handled PROPERLY: routed to a sensible destination for what it is, with a title/summary that matches the capture — OR correctly left alone if it was pure noise. Mark it a failure ONLY if the handling is clearly wrong: filed as the wrong type, a summary that misreads the capture, or an actionable item dropped as noise. Reply with ONLY a JSON object: {\"ok\": true|false, \"note\": \"one short sentence saying why\"}.";
  const user = `CAPTURED:\n${input.slice(0, 1500)}\n\nHANDLED AS:\n${handling}\n\nWas this proper handling?`;
  try {
    const raw = await completeText("inbox.verify", {
      system,
      user,
      label: "inbox verify",
      signal: AbortSignal.timeout(60_000),
    });
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { ok?: unknown; note?: unknown };
    return {
      ok: parsed.ok !== false, // anything but an explicit false passes
      note: String(parsed.note ?? "").slice(0, 200) || "audited",
    };
  } catch {
    // Verifier hiccup is not a handling failure — fail open.
    return { ok: true, note: "audit skipped — accepted" };
  }
}
