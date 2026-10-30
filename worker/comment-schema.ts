import { z } from "zod";
import { MAX_COMMENT_BODY } from "../shared/comments";

export const commentBody = z.string().trim().min(1, "Write a comment first").max(MAX_COMMENT_BODY);
export const commentAnchor = z.object({
  pageId: z.string().min(1), nodeId: z.string().min(1).nullable(),
  x: z.number().finite(), y: z.number().finite(),
});
export const newComment = z.object({ anchor: commentAnchor, body: commentBody });
export const commentReply = z.object({ body: commentBody });
export const commentResolution = z.object({ resolved: z.boolean() });
