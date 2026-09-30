import { redirect } from "next/navigation";

/**
 * Home = Today: the tiered widget deck (the old /deck, which now redirects
 * here). Two competing morning pages meant neither was trusted.
 */
export default function Home() {
  redirect("/m/today");
}
