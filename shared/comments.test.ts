import { describe, expect, it } from "vitest";
import { mayDeleteMessage, mayDeleteThread } from "./comments";
import type { Actor } from "./types";

const alice: Actor = { id: "alice", name: "Alice", avatar: null };
const alicesAgent: Actor = { ...alice, name: "Alice's agent", agent: true };
const bob: Actor = { id: "bob", name: "Bob", avatar: null };

describe("who may delete a comment", () => {
  it("lets a member delete what they or their agent wrote, and an owner delete anything", () => {
    expect(mayDeleteMessage(alice, alice, false)).toBe(true);
    expect(mayDeleteMessage(alicesAgent, alice, false)).toBe(true);
    expect(mayDeleteMessage(bob, alice, false)).toBe(false);
    expect(mayDeleteMessage(bob, alice, true)).toBe(true);
  });

  it("lets an agent delete only its own messages, whatever its member's role", () => {
    expect(mayDeleteMessage(alicesAgent, alicesAgent, false)).toBe(true);
    expect(mayDeleteMessage(alice, alicesAgent, true)).toBe(false);
    expect(mayDeleteMessage({ ...bob, agent: true }, alicesAgent, true)).toBe(false);
  });

  it("decides a thread by its first message for members, and by every message for agents", () => {
    const thread = [{ author: alicesAgent }, { author: bob }];
    expect(mayDeleteThread(thread, alice, false)).toBe(true);
    expect(mayDeleteThread(thread, bob, false)).toBe(false);
    expect(mayDeleteThread(thread, alicesAgent, false)).toBe(false);
    expect(mayDeleteThread([{ author: alicesAgent }, { author: alicesAgent }], alicesAgent, false)).toBe(true);
    expect(mayDeleteThread([], alice, true)).toBe(false);
  });
});
