import { listIdeas } from "../actions";
import { IdeasBoard } from "../components/IdeasBoard";
import { SectionTabs } from "@/core/ui/SectionTabs";

export async function IdeasPage() {
  const items = await listIdeas();
  return (
    <>
      <SectionTabs section="library" />
      <IdeasBoard items={items} />
    </>
  );
}
