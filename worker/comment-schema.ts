import { z } from "zod";
import { MAX_COMMENT_BODY } from "../shared/comments";
import { MAX_MENTIONS } from "../shared/mentions";

export const commentBody = z.string().trim().min(1, "Write a comment first").max(MAX_COMMENT_BODY);
export const commentAnchor = z.object({
  pageId: z.string().min(1), nodeId: z.string().min(1).nullable(),
  x: z.number().finite(), y: z.number().finite(),
});
/** Member ids the body tags as `@Name`. Ids outside the file's workspace are dropped. */
export const commentMentions = z.array(z.string().min(1)).max(MAX_MENTIONS).optional();
export const newComment = z.object({ anchor: commentAnchor, body: commentBody, mentions: commentMentions });
export const commentReply = z.object({ body: commentBody, mentions: commentMentions });
export const commentResolution = z.object({ resolved: z.boolean() });
