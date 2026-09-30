import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowRight } from "lucide-react";
import { db } from "@/core/db/client";
import { aiRoutes } from "@/core/db/schema/ai-routes";
import { ensureDefaultRoutes } from "@/core/ai/routing";
import { getSetting } from "@/core/app-settings";
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODEL_KEY } from "@/core/embeddings";
import { GlassPanel } from "@/core/ui/GlassPanel";
import { RoutesEditor } from "../components/RoutesEditor";
import { EmbeddingModelPicker } from "../components/EmbeddingModelPicker";
import { SettingsNav } from "../components/SettingsNav";

/** Settings · Models & Routing — app-wide model routes and embeddings. The
 *  per-agent models and the Workbench executors live with their modules. */
export async function ModelsPage() {
  await ensureDefaultRoutes();
  const [routes, embeddingModel] = await Promise.all([
    db.select().from(aiRoutes).orderBy(asc(aiRoutes.taskKey)),
    getSetting(EMBEDDING_MODEL_KEY),
  ]);

  return (
    <div className="max-w-6xl">
      <SettingsNav />
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 xl:grid-cols-2">
        <div className="flex flex-col gap-5">
          <RoutesEditor routes={routes} />
        </div>
        <div className="flex flex-col gap-5">
          <EmbeddingModelPicker
            initial={embeddingModel ?? DEFAULT_EMBEDDING_MODEL}
          />
          <GlassPanel className="flex flex-col gap-1 p-2">
            {[
              {
                href: "/m/agents/models",
                title: "Agent models",
                hint: "the provider and model each agent runs on",
              },
              {
                href: "/m/workbench/executors",
                title: "Run executors",
                hint: "the coding CLIs a run can use, and their models",
              },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-white/4"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{l.title}</span>
                  <span className="block text-xs text-ink-faint">{l.hint}</span>
                </span>
                <ArrowRight className="size-4 text-ink-faint transition group-hover:translate-x-0.5 group-hover:text-ink-dim" />
              </Link>
            ))}
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}
