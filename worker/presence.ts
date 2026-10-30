import { z } from "zod";

/** Only geometry comes from a socket. Member names, avatars and IDs come from its verified attachment. */
export const presenceMessage = z.object({
  pageId: z.string().max(200).nullable(),
  selection: z.array(z.string().max(200)).max(500),
  cursor: z.object({ x: z.number().finite(), y: z.number().finite() }).nullable(),
});
