import type { Rect } from "../shared/layout";
import { previewCurrent, type CanvasNode } from "../shared/types";

/** Screen position = world position * z + camera offset. */
export type Camera = { x: number; y: number; z: number };
export type ProjectedNode = { node: CanvasNode; rect: Rect; screenWidth: number; visibleArea: number };

/** Above this device-pixel width, use a DOM preview rather than the raster layer. */
export const HI_RES_MIN_PIXELS = 280;
const LIVE_FRAME_MIN_WIDTH = 360;
const LIVE_COMPONENT_MIN_WIDTH = 220;
const LIVE_WITHOUT_PREVIEW_MIN_WIDTH = 140;
const MAX_LIVE_WITH_PREVIEW = 6;
const MAX_LIVE_WITHOUT_PREVIEW = 12;
const MAX_ORIGINAL_IMAGES = 8;

type Viewport = {
  camera: Camera;
  size: { w: number; h: number };
  pixelRatio: number;
  ready: boolean;
  settled: boolean;
  /** The one design this viewer is playing. It stays mounted while panned away, so its input state survives. */
  interactionId?: string | null;
  previous: { liveIds: ReadonlySet<string>; imageIds: ReadonlySet<string> };
};

/**
 * Choose the canvas layers and expensive live content from one viewport snapshot.
 * While navigating, keep eligible content alive but never promote new iframes or originals.
 * This policy is independent of React, image loading, and source fetching.
 */
export function planCanvasRendering(nodes: CanvasNode[], rects: ReadonlyMap<string, Rect>, viewport: Viewport) {
  const { camera, size, pixelRatio, ready, settled, previous, interactionId } = viewport;
  const visible: ProjectedNode[] = [];
  const sections: ProjectedNode[] = [];
  let playingVisible = false;
  // The default 100% camera is not the opening overview. Wait for the first fitted/restored camera.
  if (ready && size.w && size.h) {
    const view = { x: -camera.x / camera.z, y: -camera.y / camera.z, w: size.w / camera.z, h: size.h / camera.z };
    const margin = Math.max(view.w, view.h) * 0.25;
    for (const node of nodes) {
      const rect = rects.get(node.id)!;
      const playing = node.id === interactionId && canInteract(node);
      playingVisible ||= playing;
      if (!playing && (rect.x > view.x + view.w + margin || rect.y > view.y + view.h + margin ||
          rect.x + rect.w < view.x - margin || rect.y + rect.h < view.y - margin)) continue;
      const visibleWidth = Math.max(0, Math.min(rect.x + rect.w, view.x + view.w) - Math.max(rect.x, view.x));
      const visibleHeight = Math.max(0, Math.min(rect.y + rect.h, view.y + view.h) - Math.max(rect.y, view.y));
      const projected = { node, rect, screenWidth: rect.w * camera.z, visibleArea: visibleWidth * visibleHeight * camera.z * camera.z };
      (node.kind === "section" ? sections : visible).push(projected);
    }
  }
  // Paint outer sections first so nested ones remain visible.
  sections.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);

  const liveCandidates = visible.filter(canRenderLive);
  let liveIds: Set<string>;
  if (settled) {
    liveCandidates.sort((a, b) => b.visibleArea - a.visibleArea);
    // An outdated preview (after a theme or source change) is as unusable as a missing one.
    const withPreview = liveCandidates.filter(({ node }) => previewCurrent(node)).slice(0, MAX_LIVE_WITH_PREVIEW);
    const withoutPreview = liveCandidates.filter(({ node }) => !previewCurrent(node)).slice(0, MAX_LIVE_WITHOUT_PREVIEW);
    liveIds = new Set([...withPreview, ...withoutPreview].map(({ node }) => node.id));
  } else {
    liveIds = keepEligible(previous.liveIds, liveCandidates);
  }
  // Playback needs the source, so it counts as live; other live previews keep their budget.
  if (playingVisible) liveIds.add(interactionId!);

  const imageCandidates = visible.filter(({ node, visibleArea, screenWidth }) =>
    node.kind === "image" && visibleArea > 0 && screenWidth * pixelRatio > HI_RES_MIN_PIXELS);
  const imageIds = settled
    ? new Set(imageCandidates.sort((a, b) => b.visibleArea - a.visibleArea).slice(0, MAX_ORIGINAL_IMAGES).map(({ node }) => node.id))
    : keepEligible(previous.imageIds, imageCandidates);

  const domFrames: ProjectedNode[] = [];
  const rasterFrames: ProjectedNode[] = [];
  for (const projected of visible) {
    const { node, screenWidth } = projected;
    const useDom = node.kind === "image"
      ? imageIds.has(node.id)
      : liveIds.has(node.id) || screenWidth * pixelRatio > HI_RES_MIN_PIXELS;
    (useDom ? domFrames : rasterFrames).push(projected);
  }
  return { sections, domFrames, rasterFrames, liveIds, imageIds };
}

function canRenderLive({ node, visibleArea, screenWidth }: ProjectedNode) {
  if (node.kind !== "frame" && node.kind !== "component" && node.kind !== "tokens") return false;
  const minimumWidth = !previewCurrent(node)
    ? LIVE_WITHOUT_PREVIEW_MIN_WIDTH
    : node.kind === "component" ? LIVE_COMPONENT_MIN_WIDTH : LIVE_FRAME_MIN_WIDTH;
  return visibleArea > 0 && screenWidth >= minimumWidth;
}

/** Viewers can play any frame or component; the session and its input stay local to them. */
export function canInteract(node: Pick<CanvasNode, "kind"> | null | undefined) {
  return node?.kind === "frame" || node?.kind === "component";
}

function keepEligible(previous: ReadonlySet<string>, candidates: ProjectedNode[]) {
  const eligible = new Set(candidates.map(({ node }) => node.id));
  return new Set([...previous].filter(id => eligible.has(id)));
}
