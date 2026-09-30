import { redirect } from "next/navigation";

// The deck became the Today page (one home, not two). Old links land there.
export default function DeckRedirect() {
  redirect("/m/today");
}
