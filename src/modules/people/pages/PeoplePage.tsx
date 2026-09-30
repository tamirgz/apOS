import { listPeople } from "../queries";
import { isSystemContact } from "../display";
import { PeopleList } from "../components/PeopleList";

export async function PeoplePage() {
  // Calendar group addresses and automated senders aren't people — hide them.
  const people = (await listPeople()).filter((p) => !isSystemContact(p));
  return <PeopleList people={people} />;
}
