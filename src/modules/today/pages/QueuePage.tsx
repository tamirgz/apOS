import { getToday, listNeedsYou, splitHygiene } from "../queries";
import { PlanMyDay } from "../components/PlanMyDay";
import { NeedsYouQueue } from "../components/NeedsYouQueue";

/**
 * The full "Needs you" queue (inline done/snooze/dismiss/approve) beside the
 * day plan — the working view behind the home page's Needs-you card.
 */
export async function QueuePage() {
  const [{ agenda, suggestions }, needs] = await Promise.all([
    getToday(),
    listNeedsYou(),
  ]);
  const { focus, hygiene } = splitHygiene(needs);

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <PlanMyDay agenda={agenda} suggestions={suggestions} />
      <NeedsYouQueue items={focus} hygiene={hygiene} />
    </div>
  );
}
