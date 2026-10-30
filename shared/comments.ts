import type { CommentAnchor } from "./types";
import type { Rect } from "./layout";

export const MAX_COMMENT_BODY = 5000;

export function commentPoint(anchor: CommentAnchor, rects: ReadonlyMap<string, Rect>) {
  const rect = anchor.nodeId ? rects.get(anchor.nodeId) : undefined;
  return { x: (rect?.x ?? 0) + anchor.x, y: (rect?.y ?? 0) + anchor.y };
}
