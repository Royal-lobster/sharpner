import { describe, expect, it } from "vitest";
import { peopleInFile } from "./presence";
import type { Actor, Peer } from "../shared/types";

describe("active people", () => {
  it("deduplicates tabs, preserves page locations, includes self once and keeps agent activity separate", () => {
    const self: Actor = { id: "alice", name: "Alice", avatar: null };
    const peer = (id: string, cid: string, pageId: string, agent = false): Peer => ({ id, cid, pageId, agent, name: id, avatar: null, selection: [], cursor: null });
    const people = peopleInFile([
      peer("bob", "tab1", "screens"), peer("bob", "tab2", "tokens"), peer("bob", "tab3", "tokens"),
      peer("alice", "another-tab", "tokens"), peer("agent", "agent", "screens", true),
    ], self, "screens");
    expect(people).toEqual([
      { ...self, pageIds: ["screens", "tokens"] },
      { id: "bob", name: "bob", avatar: null, pageIds: ["screens", "tokens"] },
    ]);
  });
});
