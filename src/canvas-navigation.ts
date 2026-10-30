import { union, type Rect } from "../shared/layout";
import type { Camera } from "./canvas-render-plan";

export const MAX_CANVAS_ZOOM = 8;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A page's preview stays within its content, with space for labels and the editor controls. */
export function canvasNavigation(rects: Rect[], size: { w: number; h: number }) {
  const bounds = rects.length ? union(rects) : { x: 0, y: 0, w: 800, h: 600 };
  const width = Math.max(1, size.w), height = Math.max(1, size.h);
  const compact = width < 560;
  const left = Math.min(compact ? 20 : 64, (width - 1) / 2);
  const top = Math.min(compact ? 68 : 64, (height - 1) / 3);
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

  const axis = (offset: number, start: number, extent: number, viewStart: number, viewExtent: number, z: number) => {
    const center = viewStart + (viewExtent - extent * z) / 2 - start * z;
    // A cluster that fits on an axis stays centered there instead of sliding into empty space.
    if (extent * z <= viewExtent) return center;
    const desired = Number.isFinite(offset) ? offset : center;
    return clamp(desired, viewStart + viewExtent - (start + extent) * z, viewStart - start * z);
  };
  const constrain = (camera: Camera): Camera => {
    const z = Number.isFinite(camera.z) && camera.z > 0 ? clamp(camera.z, minZoom, MAX_CANVAS_ZOOM) : minZoom;
    return { z,
      x: axis(camera.x, bounds.x, bounds.w, viewport.x, viewport.w, z),
      y: axis(camera.y, bounds.y, bounds.h, viewport.y, viewport.h, z),
    };
  };

  return { bounds, minZoom, overview, constrain,
    fit: (targets: Rect[], maxZoom = 1) => constrain(fitRect(targets.length ? union(targets) : bounds, maxZoom)),
  };
}
