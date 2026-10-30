import { describe, expect, it } from "vitest";
import { canvasNavigation, MAX_CANVAS_ZOOM } from "./canvas-navigation";
import { applyTouch } from "./touch-gestures";
import type { Camera } from "./canvas-render-plan";

const desktop = { w: 1600, h: 950 };
const cluster = { x: -1200, y: 400, w: 5000, h: 8000 };
const expectCamera = (actual: Camera, expected: Camera) => {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
  expect(actual.z).toBeCloseTo(expected.z, 8);
};

describe("bounded preview navigation", () => {
  it("makes the fitted overview the furthest zoom out and locks panning at that overview", () => {
    const nav = canvasNavigation([cluster], desktop);
    expect(nav.minZoom).toBeCloseTo((desktop.h - 128) / cluster.h);
    expectCamera(nav.fit([]), nav.overview);
    for (const x of [-1e10, 0, 1e10]) for (const y of [-1e10, 0, 1e10]) {
      expectCamera(nav.constrain({ x, y, z: 0.00001 }), nav.overview);
      expectCamera(nav.constrain({ x, y, z: nav.minZoom }), nav.overview);
    }
  });

  it("stops at each edge while keeping all four edges reachable at higher zoom", () => {
    const nav = canvasNavigation([cluster], desktop);
    const first = nav.constrain({ x: 1e10, y: 1e10, z: 1 });
    expect(cluster.x + first.x).toBe(64);
    expect(cluster.y + first.y).toBe(64);
    const last = nav.constrain({ x: -1e10, y: -1e10, z: 1 });
    expect(cluster.x + cluster.w + last.x).toBe(desktop.w - 64);
    expect(cluster.y + cluster.h + last.y).toBe(desktop.h - 64);
    expectCamera(nav.constrain(first), first);
    expectCamera(nav.constrain(last), last);
    // Reversing direction moves immediately; there is no accumulated overscroll to undo.
    expect(nav.constrain({ ...first, x: first.x - 20 }).x).toBe(first.x - 20);
  });

  it("centers a narrow cluster horizontally while allowing vertical scrolling", () => {
    const narrow = { x: 900, y: -500, w: 200, h: 5000 };
    const nav = canvasNavigation([narrow], { w: 1000, h: 800 });
    const first = nav.constrain({ x: 1e10, y: 1e10, z: 0.5 });
    const last = nav.constrain({ x: -1e10, y: -1e10, z: 0.5 });
    expect(first.x).toBe(last.x);
    expect((narrow.x + narrow.w / 2) * first.z + first.x).toBe(500);
    expect(first.y).not.toBe(last.y);
  });

  it("keeps small designs at 100% in the overview and still allows zooming in", () => {
    const nav = canvasNavigation([{ x: 200, y: -100, w: 300, h: 200 }], desktop);
    expect(nav.minZoom).toBe(1);
    expectCamera(nav.constrain({ x: 1e10, y: -1e10, z: 0.1 }), nav.overview);
    expect(nav.constrain({ ...nav.overview, z: 2 }).z).toBe(2);
    expect(nav.constrain({ ...nav.overview, z: 1000 }).z).toBe(MAX_CANVAS_ZOOM);
  });

  it("bounds touch panning and pinching with the same policy as desktop navigation", () => {
    const nav = canvasNavigation([cluster], desktop);
    const current = nav.constrain({ x: -500, y: -2000, z: 1 });
    const panned = applyTouch(current, { type: "pan", dx: 1e10, dy: -1e10 }, nav.minZoom, MAX_CANVAS_ZOOM);
    const bounded = nav.constrain(panned);
    expect(cluster.x + bounded.x).toBe(64);
    expect(cluster.y + cluster.h + bounded.y).toBe(desktop.h - 64);
    const pinched = applyTouch(current, { type: "pinch", scale: 0.000001, from: { x: 100, y: 300 }, to: { x: 140, y: 360 } }, nav.minZoom, MAX_CANVAS_ZOOM);
    expectCamera(nav.constrain(pinched), nav.overview);
  });

  it("preserves the pinch anchor when the requested view is within the bounds", () => {
    const nav = canvasNavigation([cluster], desktop);
    const current = nav.constrain({ x: -500, y: -2000, z: 1 });
    const from = { x: 600, y: 300 }, to = { x: 660, y: 340 };
    const next = nav.constrain(applyTouch(current, { type: "pinch", scale: 2, from, to }, nav.minZoom, MAX_CANVAS_ZOOM));
    expect((to.x - next.x) / next.z).toBeCloseTo((from.x - current.x) / current.z);
    expect((to.y - next.y) / next.z).toBeCloseTo((from.y - current.y) / current.z);
  });

  it("keeps phone navigation clear of the top controls and bottom dock", () => {
    const nav = canvasNavigation([cluster], { w: 390, h: 844 });
    const first = nav.constrain({ x: 1e10, y: 1e10, z: 1 });
    const last = nav.constrain({ x: -1e10, y: -1e10, z: 1 });
    expect(cluster.x + first.x).toBe(20);
    expect(cluster.y + first.y).toBe(68);
    expect(cluster.x + cluster.w + last.x).toBe(370);
    expect(cluster.y + cluster.h + last.y).toBe(752);
  });

  it("recovers old saved positions after resize, layout shrinkage and deletion", () => {
    const old = canvasNavigation([cluster], desktop).constrain({ x: -1e10, y: -1e10, z: 0.2 });
    const updated = canvasNavigation([{ x: 50000, y: -9000, w: 400, h: 600 }], { w: 390, h: 844 });
    expectCamera(updated.constrain(old), updated.overview);
    const empty = canvasNavigation([], desktop);
    expectCamera(empty.constrain({ ...old, z: 1 }), empty.overview);
  });

  it("allows navigation to newly added screens and detached comment pins", () => {
    const rects = [cluster, { x: 12000, y: 15000, w: 400, h: 600 }, { x: -2000, y: 300, w: 1, h: 1 }];
    const nav = canvasNavigation(rects, desktop);
    expect(nav.bounds).toEqual({ x: -2000, y: 300, w: 14400, h: 15300 });
    for (const rect of rects) {
      const target = nav.fit([rect], 2);
      expect(rect.x * target.z + target.x).toBeLessThan(desktop.w);
      expect((rect.x + rect.w) * target.z + target.x).toBeGreaterThan(0);
      expect(rect.y * target.z + target.y).toBeLessThan(desktop.h);
      expect((rect.y + rect.h) * target.z + target.y).toBeGreaterThan(0);
    }
  });

  it("can fit huge pages below the old 1% floor and handles tiny or empty viewports", () => {
    const huge = canvasNavigation([{ x: -1e6, y: -1e6, w: 2e6, h: 2e6 }], desktop);
    expect(huge.minZoom).toBeLessThan(0.01);
    expect(huge.minZoom).toBeGreaterThan(0);
    for (const size of [{ w: 0, h: 0 }, { w: 1, h: 1 }, { w: 120, h: 80 }]) {
      const nav = canvasNavigation([], size);
      const recovered = nav.constrain({ x: NaN, y: Infinity, z: -1 });
      expect(Object.values(recovered).every(Number.isFinite)).toBe(true);
      expect(recovered.z).toBeGreaterThan(0);
    }
  });
});
