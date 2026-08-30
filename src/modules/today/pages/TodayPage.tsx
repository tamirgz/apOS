import { getToday, listNeedsYou } from "../queries";
import { PlanMyDay } from "../components/PlanMyDay";
import { NeedsYouQueue } from "../components/NeedsYouQueue";
import { TodayBriefs } from "../components/TodayBriefs";

/**
 * The command surface (ONE-STOP §3), and the home page: "what's my day, what
 * needs me, and what did my agents bring in?" — Plan-my-day + today's briefs
 * on the left, the "Needs you" queue on the right.
 */
export async function TodayPage() {
  const [{ agenda, suggestions }, needs] = await Promise.all([
    getToday(),
    listNeedsYou(),
  ]);

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      <div className="flex flex-col gap-5">
        <PlanMyDay agenda={agenda} suggestions={suggestions} />
        <TodayBriefs />
      </div>
      <NeedsYouQueue items={needs} />
    </div>
  );
}
