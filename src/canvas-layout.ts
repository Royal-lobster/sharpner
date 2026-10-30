import { catalogFamilyLabels, catalogSectionIds, layoutRects, union } from "../shared/layout";
import { commentPoint } from "../shared/comments";
import { canvasNavigation } from "./canvas-navigation";
import type { Room } from "./room";

function pageGeometry(room: Room, pageId: string) {
  const frames = room.pageNodes(pageId);
  const rects = layoutRects(frames, (node) => room.heightOf(node), room.dragging);
  const catalogs = catalogSectionIds(frames);
  return {
    frames, rects, catalogs,
    sections: frames.filter((node) => node.kind === "section"),
    nodes: frames.filter((node) => node.kind !== "section"),
    families: catalogFamilyLabels(frames, rects, catalogs),
    bounds: rects.size ? union([...rects.values()]) : null,
  };
}

type Geometry = ReturnType<typeof pageGeometry>;
type Navigation = { navigationRects: NonNullable<Geometry["bounds"]>[]; navigation: ReturnType<typeof canvasNavigation> };

/** One active page per canvas. Camera, presence and preview loads reuse world geometry. */
export class CanvasLayout {
  private geometry: { pageId: string; revision: number; dragging: Set<string>; value: Geometry } | null = null;
  private view: { geometry: Geometry; comments: number; activeCommentId: string | null; width: number; height: number; value: Navigation } | null = null;

  constructor(private room: Room) {}

  page(pageId: string): Geometry {
    const cached = this.geometry;
    if (cached?.pageId === pageId && cached.revision === this.room.dataRevision &&
      cached.dragging.size === this.room.dragging.size && [...this.room.dragging].every((id) => cached.dragging.has(id))) return cached.value;
    const value = pageGeometry(this.room, pageId);
    this.geometry = { pageId, revision: this.room.dataRevision, dragging: new Set(this.room.dragging), value };
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
