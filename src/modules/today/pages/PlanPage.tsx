import type { ModuleRouteProps } from "@/core/modules/types.server";
import { getPlanDay } from "../plan";
import { PlanBoard } from "../components/PlanBoard";

/** /m/today/plan[/YYYY-MM-DD] — timebox one day: candidates on the left, the day on the right. */
export async function PlanPage({ params }: ModuleRouteProps) {
  const plan = await getPlanDay(params[1]);
  return <PlanBoard plan={plan} />;
}
