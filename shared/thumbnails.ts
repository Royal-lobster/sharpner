import { effectiveTheme } from "./themes";
import type { CanvasNode } from "./types";

/** Empty theme key means As authored (also used by theme-independent token specimens). */
export type Thumbnail = { rev: number; lo: string; hi: string; measuredHeight: number | null };
export type ThemeThumbnails = Record<string, Thumbnail>;

/** Select without throwing away the last image: missing pairs retain today's dimmed fallback. */
export function selectThumbnail<T extends CanvasNode>(node: T, fileTheme: string | null): T {
  if (!node.thumbnails) return node;
  const theme = effectiveTheme(node, fileTheme) ?? "";
  const thumbnail = node.thumbnails[theme];
  if (thumbnail?.rev === node.rev) return {
    ...node, thumbLo: thumbnail.lo, thumbHi: thumbnail.hi, thumbRev: thumbnail.rev,
    thumbTheme: theme, measuredHeight: thumbnail.measuredHeight,
  };
  // A cached image of another theme is never current, even when its content revision matches.
  return { ...node, thumbRev: node.thumbTheme === theme ? node.thumbRev : 0 };
}
