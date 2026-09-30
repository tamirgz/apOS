import { listKnowledge } from "../actions";
import { KnowledgeBoard } from "../components/KnowledgeBoard";
import { SectionTabs } from "@/core/ui/SectionTabs";

export async function KnowledgePage() {
  const items = await listKnowledge();
  return (
    <>
      <SectionTabs section="library" />
      <KnowledgeBoard items={items} />
    </>
  );
}
