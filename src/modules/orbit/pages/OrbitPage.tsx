import { orbitGraph } from "../queries";
import { OrbitGraph } from "../components/OrbitGraph";
import { SectionTabs } from "@/core/ui/SectionTabs";

export async function OrbitPage() {
  const data = await orbitGraph();
  return (
    <>
      <SectionTabs section="library" />
      <OrbitGraph data={data} />
    </>
  );
}
