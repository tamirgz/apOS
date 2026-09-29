import { createElement } from "react";
import Link from "next/link";
import { getServerModule } from "@/modules/registry.server";
import { resolveModuleRoute } from "@/core/modules/resolve";
import { GlassPanel } from "@/core/ui/GlassPanel";

function NotFound({ path }: { path: string }) {
  return (
    <GlassPanel className="flex flex-col items-center gap-3 px-8 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-flare">
        signal lost
      </p>
      <h2 className="font-display text-3xl font-semibold text-ink">
        No module answers at <code className="text-ion">/{path}</code>
      </h2>
      <Link
        href="/"
        className="mt-2 rounded-lg border border-plasma/30 px-4 py-2 font-mono text-xs uppercase tracking-widest text-plasma transition hover:bg-plasma/10"
      >
        return to deck
      </Link>
    </GlassPanel>
  );
}

export default async function ModulePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const [moduleId, ...rest] = slug;

  const mod = getServerModule(moduleId);
  if (!mod) return <NotFound path={slug.join("/")} />;

  const Route = resolveModuleRoute(mod, rest);
  if (!Route) return <NotFound path={slug.join("/")} />;

  // Route is a static entry from the module registry, not a component made
  // here; createElement says so without tripping react-hooks/static-components.
  return createElement(Route, { params: rest });
}
