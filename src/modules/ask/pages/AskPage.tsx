import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/core/db/client";
import { chatRuns } from "@/core/db/schema/chat-runs";
import { listAskHistory } from "../actions";
import { listProjectOptions } from "@/modules/projects/queries";
import { AskConsole, type PastChat } from "../components/AskConsole";

/** Finished ⌘K chats — so every past AI answer is findable from one place. */
async function listPastChats(): Promise<PastChat[]> {
  const rows = await db
    .select({
      id: chatRuns.id,
      title: chatRuns.title,
      answer: chatRuns.result,
      model: chatRuns.model,
      createdAt: chatRuns.createdAt,
    })
    .from(chatRuns)
    .where(and(eq(chatRuns.taskKey, "chat"), eq(chatRuns.status, "succeeded"), isNotNull(chatRuns.result)))
    .orderBy(desc(chatRuns.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r, answer: r.answer ?? "" }));
}

export async function AskPage() {
  const [history, projectOptions, pastChats] = await Promise.all([
    listAskHistory(),
    listProjectOptions(),
    listPastChats(),
  ]);
  return (
    <AskConsole initialHistory={history} projectOptions={projectOptions} pastChats={pastChats} />
  );
}
