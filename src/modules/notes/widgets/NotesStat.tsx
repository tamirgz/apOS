import { desc, sql } from "drizzle-orm";
import { db } from "@/core/db/client";
import { StatCell } from "@/core/ui/StatCell";
import { notes } from "../schema";

/** Ambient strip: note count + when the vault was last touched. */
export async function NotesStat() {
  const [c] = await db
    .select({
      total: sql<number>`count(*)`,
      latest: sql<Date | null>`max(${notes.updatedAt})`,
    })
    .from(notes);
  const latest = c.latest ? new Date(c.latest) : null;
  return (
    <StatCell
      label="Notes"
      value={Number(c.total)}
      hint={
        latest
          ? `· ${latest.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
          : undefined
      }
      href="/m/notes"
      accent="var(--color-ion)"
    />
  );
}
