import type { Actor, Peer } from "../shared/types";

export type ActivePerson = Actor & { pageIds: string[] };

/** A member can have several tabs and pages open, but occupies one place in the avatar stack. */
export function peopleInFile(peers: Iterable<Peer>, self: Actor, pageId: string | null): ActivePerson[] {
  const people = new Map<string, ActivePerson>([[self.id, { ...self, pageIds: pageId ? [pageId] : [] }]]);
  for (const peer of peers) {
    if (peer.agent) continue;
    const person = people.get(peer.id) ?? { id: peer.id, name: peer.name, avatar: peer.avatar, pageIds: [] };
    if (peer.pageId && !person.pageIds.includes(peer.pageId)) person.pageIds.push(peer.pageId);
    people.set(peer.id, person);
  }
  return [...people.values()];
}
