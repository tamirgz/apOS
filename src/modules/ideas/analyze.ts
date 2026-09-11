import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, sql } from "@/core/db/client";
import type { ModuleJob } from "@/core/modules/types.server";
import { resolveRoute } from "@/core/ai/routing";
import { ideas, type IdeaAnalysis } from "./schema";

const AnalysisSchema = z.object({
  verdict: z
    .enum(["pursue", "explore", "park"])
    .describe(
      "pursue = clearly worth building now; explore = promising but needs validation; park = not now",
    ),
  score: z.number().min(1).max(10).describe("Overall potential, 1-10"),
  summary: z.string().describe("3-4 sentence sharp assessment"),
  strengths: z.array(z.string()).describe("What makes this idea strong"),
  risks: z
    .array(z.string())
    .describe("The uncomfortable truths: risks, competition, effort traps"),
  validationSteps: z
    .array(z.string())
    .describe("Concrete cheap next steps to validate or kill it fast"),
});

/** Reality-check an idea: adversarial, VC-style, memory-aware. */
export async function analyzeIdea(ideaId: string): Promise<void> {
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) return;

  const set = async (patch: Record<string, unknown>) => {
    await db
      .update(ideas)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ideas.id, ideaId));
    await sql.notify("ideas_changed", ideaId);
  };

  try {
    await set({ analysisStatus: "analyzing", analysisError: null });
    const route = await resolveRoute("ideas.analyze");
    const { renderMemoryContext } = await import("@/core/memory");

    let captured: IdeaAnalysis | null = null;
    const submitTool = {
      name: "ideas.submitAnalysis",
      description: "Submit the structured reality-check. Call exactly once.",
      input: AnalysisSchema,
      execute: async (input: IdeaAnalysis) => {
        captured = input;
        return { saved: true };
      },
    };

    let finalText = "";
    for await (const event of route.provider.run({
      system: [
        "You are the idea reality-check engine of apOS, the user's Agentic Personalized Operating System.",
        "Assess ideas like a sharp, honest advisor: lead with the uncomfortable truth, no flattery, no filler.",
        "Ground the assessment in who the user is and what they're focused on (memory below).",
        "",
        await renderMemoryContext(),
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `IDEA (${idea.category}): ${idea.title}`,
            idea.notes ? `NOTES: ${idea.notes}` : null,
            "",
            "Reality-check this idea and submit via ideas.submitAnalysis. Call the tool exactly once.",
          ]
            .filter((x) => x !== null)
            .join("\n"),
        },
      ],
      tools: [submitTool],
      toolCtx: { db },
      track: { source: "job", label: "idea analysis" },
      model: route.model,
      // The SDK counts internal tool rounds too — a structured multi-section
      // analysis needs headroom (8 was not enough in practice).
      maxTurns: 20,
    })) {
      if (event.type === "done") finalText = event.text;
      if (event.type === "error") throw new Error(event.message);
    }

    if (!captured) {
      const jsonMatch = finalText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = AnalysisSchema.safeParse(JSON.parse(jsonMatch[0]));
        if (parsed.success) captured = parsed.data;
      }
    }
    if (!captured) throw new Error("analysis produced no structured output");

    await set({ analysisStatus: "ready", analysis: captured });
    const { notify } = await import("@/core/notify");
    await notify({
      title: `Idea analyzed: ${idea.title.slice(0, 60)}`,
      body: `${(captured as IdeaAnalysis).verdict.toUpperCase()} · ${(captured as IdeaAnalysis).score}/10 — ${(captured as IdeaAnalysis).summary.slice(0, 200)}`,
      level: "info",
      source: "ideas",
      href: `/m/ideas/${ideaId}`,
    });
  } catch (e) {
    await set({
      analysisStatus: "error",
      analysisError: String(e).slice(0, 400),
    });
  }
}

export const ideaJobs: ModuleJob[] = [
  { channel: "idea_analyze", handle: (payload) => analyzeIdea(payload) },
];
