import { ModuleNotFound } from "@/core/modules/ModuleNotFound";

/**
 * Only unknown modules land here: each module has its own route folder,
 * app/(shell)/m/<id>/[[...rest]], so a page bundles only that module's UI.
 */
export default async function UnknownModulePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  return <ModuleNotFound path={slug.join("/")} />;
}
