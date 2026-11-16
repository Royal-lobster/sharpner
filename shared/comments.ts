import type { Actor, CommentAnchor } from "./types";
import type { Rect } from "./layout";

export const MAX_COMMENT_BODY = 5000;

export function commentPoint(anchor: CommentAnchor, rects: ReadonlyMap<string, Rect>) {
  const rect = anchor.nodeId ? rects.get(anchor.nodeId) : undefined;
  return { x: (rect?.x ?? 0) + anchor.x, y: (rect?.y ?? 0) + anchor.y };
}

type Deleter = Pick<Actor, "id" | "agent">;

/**
 * Who may delete a comment message: its author, the member whose agent wrote it, or a workspace owner. An agent may
 * delete only what that agent wrote; it never moderates members' comments.
 */
export function mayDeleteMessage(author: Actor, by: Deleter, owner: boolean) {
  if (by.agent) return !!author.agent && author.id === by.id;
  return owner || author.id === by.id;
}

/**
 * Deleting a thread deletes its replies too. A member may do it when they may delete the first message; an agent only
 * when every message in the thread is its own.
 */
export function mayDeleteThread(messages: readonly { author: Actor }[], by: Deleter, owner: boolean) {
  if (!messages.length) return false;
  return by.agent ? messages.every((m) => mayDeleteMessage(m.author, by, owner)) : mayDeleteMessage(messages[0]!.author, by, owner);
}

export const DELETE_COMMENT_DENIED = "Only its author or a workspace owner can delete this comment";
