import { orbitGraph } from "../queries";
import { OrbitGraph } from "../components/OrbitGraph";

export async function OrbitPage() {
  const data = await orbitGraph();
  return <OrbitGraph data={data} />;
}
