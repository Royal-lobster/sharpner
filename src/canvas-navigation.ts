import { union, type Rect } from "../shared/layout";
import type { Camera } from "./canvas-render-plan";
import { LABEL_ROOM } from "./canvas-labels";

export const MAX_CANVAS_ZOOM = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Fit locks the page overview; zoomed previews can be panned freely to inspect any detail. */
export function canvasNavigation(rects: Rect[], size: { w: number; h: number }) {
  const bounds = rects.length ? union(rects) : { x: 0, y: 0, w: 800, h: 600 };
  const width = Math.max(1, size.w), height = Math.max(1, size.h);
  const compact = width < 560;
  const left = Math.min(compact ? 20 : 64, (width - 1) / 2);
  // The file controls float over the top edge; the topmost node's label or section title must clear them too.
  const top = Math.min((compact ? 68 : 64) + LABEL_ROOM, (height - 1) / 3);
  const bottom = Math.min(compact ? 92 : 64, (height - 1) / 3);
  const viewport = { x: left, y: top, w: width - left * 2, h: height - top - bottom };

  const fitRect = (rect: Rect, maxZoom: number): Camera => {
    const z = Math.min(maxZoom, viewport.w / Math.max(1, rect.w), viewport.h / Math.max(1, rect.h));
    return { z, x: viewport.x + (viewport.w - rect.w * z) / 2 - rect.x * z,
      y: viewport.y + (viewport.h - rect.h * z) / 2 - rect.y * z };
  };
  // Small designs open at 100%; large clusters can always fit, even below the old 1% zoom floor.
  const overview = fitRect(bounds, 1);
  const minZoom = overview.z;

  const constrain = (camera: Camera): Camera => {
    const z = Number.isFinite(camera.z) && camera.z > 0 ? clamp(camera.z, minZoom, MAX_CANVAS_ZOOM) : minZoom;
    if (z === minZoom) return overview;
    // A zoomed page must be movable past its edges, including on an axis where it still fits.
    // Otherwise labels and details can get trapped behind the floating editor controls.
    return { z,
      x: Number.isFinite(camera.x) ? camera.x : viewport.x + viewport.w / 2 - (bounds.x + bounds.w / 2) * z,
      y: Number.isFinite(camera.y) ? camera.y : viewport.y + viewport.h / 2 - (bounds.y + bounds.h / 2) * z,
    };
  };

  return { bounds, minZoom, overview, constrain,
    fit: (targets: Rect[], maxZoom = 1) => constrain(fitRect(targets.length ? union(targets) : bounds, maxZoom)),
  };
}
