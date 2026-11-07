import { catalogLabels, catalogSectionIds, layoutRects, union } from "../shared/layout";
import { commentPoint } from "../shared/comments";
import { canvasNavigation } from "./canvas-navigation";
import type { Room } from "./room";
import type { CanvasNode } from "../shared/types";
import { specimenWidth } from "../shared/catalog-specimens";

/** A section's own designs: how many, the widest, and what to call them in a count. */
export type SectionContents = { count: number; width: number; noun: string };

function sectionContents(frames: CanvasNode[]) {
  const contents = new Map<string, SectionContents & { kinds: Set<string> }>();
  for (const f of frames) {
    if (!f.parentId || f.kind === "section") continue;
    const c = contents.get(f.parentId) ?? contents.set(f.parentId, { count: 0, width: 0, noun: "", kinds: new Set() }).get(f.parentId)!;
    c.count++; c.width = Math.max(c.width, specimenWidth(f)); c.kinds.add(f.kind);
  }
  for (const c of contents.values()) {
    const only = c.kinds.size === 1 ? [...c.kinds][0] : null;
    c.noun = only === "frame" ? (c.count === 1 ? "screen" : "screens") : only === "component" ? (c.count === 1 ? "component" : "components") : c.count === 1 ? "design" : "designs";
  }
  return contents as Map<string, SectionContents>;
}

function pageGeometry(room: Room, pageId: string) {
  const frames = room.pageNodes(pageId);
  const rects = layoutRects(frames, (node) => room.heightOf(node));
  const catalogs = catalogSectionIds(frames);
  const { labels, tables, cells } = catalogLabels(frames, rects, catalogs);
  return {
    frames, rects, catalogs, labels, tables, tableCells: cells, sectionContents: sectionContents(frames),
    sections: frames.filter((node) => node.kind === "section"),
    nodes: frames.filter((node) => node.kind !== "section"),
    bounds: rects.size ? union([...rects.values()]) : null,
  };
}

type Geometry = ReturnType<typeof pageGeometry>;
type Navigation = { navigationRects: NonNullable<Geometry["bounds"]>[]; navigation: ReturnType<typeof canvasNavigation> };

/** One active page per canvas. Camera, presence and preview loads reuse world geometry. */
export class CanvasLayout {
  private geometry: { pageId: string; revision: number; value: Geometry } | null = null;
  private view: { geometry: Geometry; comments: number; activeCommentId: string | null; width: number; height: number; value: Navigation } | null = null;

  constructor(private room: Room) {}

  page(pageId: string): Geometry {
    const cached = this.geometry;
    if (cached?.pageId === pageId && cached.revision === this.room.dataRevision) return cached.value;
    const value = pageGeometry(this.room, pageId);
    this.geometry = { pageId, revision: this.room.dataRevision, value };
    this.view = null;
    return value;
  }

  navigation(pageId: string, size: { w: number; h: number }, activeCommentId: string | null = null): Navigation {
    const geometry = this.page(pageId), cached = this.view;
    if (cached?.geometry === geometry && cached.comments === this.room.commentsRevision && cached.activeCommentId === activeCommentId &&
      cached.width === size.w && cached.height === size.h) return cached.value;
    // A cached union preserves the same bounds without rescanning every node after a resize or comment.
    const navigationRects = geometry.bounds ? [geometry.bounds] : [];
    for (const thread of this.room.comments.values()) {
      if (thread.anchor.pageId !== pageId || thread.resolvedAt !== null && thread.id !== activeCommentId) continue;
      navigationRects.push({ ...commentPoint(thread.anchor, geometry.rects), w: 1, h: 1 });
    }
    const value = { navigationRects, navigation: canvasNavigation(navigationRects, size) };
    this.view = { geometry, comments: this.room.commentsRevision, activeCommentId, width: size.w, height: size.h, value };
    return value;
  }
}
