/** Immutable object names: legacy revisions and content/theme SHA-256 pairs share the batch path. */
export const THUMBNAIL_NAME = "[a-f0-9-]{36}-\\d{1,12}(?:-[a-f0-9]{64})?-(?:lo|hi)\\.webp";
export const thumbnailName = new RegExp(`^${THUMBNAIL_NAME}$`, "i");
export const thumbnailUrl = new RegExp(`^/a/([a-f0-9-]{36})/t/(${THUMBNAIL_NAME})$`, "i");
