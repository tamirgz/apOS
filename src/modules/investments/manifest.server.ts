import type { ModuleServerManifest } from "@/core/modules/types.server";
import { investmentTools } from "./tools";
import { marketTools } from "./market";
import { investmentInsightTemplate } from "./insight";
import { charts } from "./schema";

export const investmentsServerManifest: ModuleServerManifest = {
  id: "investments",
  // Portfolio data lives in iSentry (Supabase); apOS owns only the generated
  // `charts` produced by viz.chart.
  schema: { charts },
  aiTools: [...investmentTools, ...marketTools],
  agentTemplates: [investmentInsightTemplate],
};
