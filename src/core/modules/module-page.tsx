import { createElement } from "react";
import { resolveModuleRoute } from "./resolve";
import { ModuleNotFound } from "./ModuleNotFound";
import type { ModulePagesManifest } from "./types.server";

/** The page for a module's route folder, app/(shell)/m/<id>/[[...rest]]/page.tsx. */
export function modulePage(mod: ModulePagesManifest) {
  return async function ModulePage({ params }: { params: Promise<{ rest?: string[] }> }) {
    const { rest = [] } = await params;
    const Route = resolveModuleRoute(mod, rest);
    if (!Route) return <ModuleNotFound path={[mod.id, ...rest].join("/")} />;
    // Route is a static entry from the module's manifest, not a component made
    // here; createElement says so without tripping react-hooks/static-components.
    return createElement(Route, { params: rest });
  };
}
