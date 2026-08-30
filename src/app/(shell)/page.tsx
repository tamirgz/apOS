import { redirect } from "next/navigation";

/**
 * Home = Today. The morning surface is /m/today (inline done/snooze/dismiss on
 * the Needs-You queue, the day plan, today's briefs); the widget deck stays
 * available at /deck as the "everything at a glance" secondary view. Two
 * competing morning pages meant neither was trusted.
 */
export default function Home() {
  redirect("/m/today");
}
