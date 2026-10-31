import { describe, expect, it } from "vitest";
import { canvasNavigation, MAX_CANVAS_ZOOM } from "./canvas-navigation";
import { applyTouch } from "./touch-gestures";
import { LABEL_ROOM } from "./canvas-labels";
import type { Camera } from "./canvas-render-plan";

const desktop = { w: 1600, h: 950 };
const cluster = { x: -1200, y: 400, w: 5000, h: 8000 };
const expectCamera = (actual: Camera, expected: Camera) => {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
  expect(actual.z).toBeCloseTo(expected.z, 8);
};

describe("bounded preview navigation", () => {
  it("lets a zoomed section be dragged down and right so its title clears the floating file controls", () => {
    const nav = canvasNavigation([{ x: 0, y: 0, w: 2000, h: 4000 }], { w: 1200, h: 800 });
    const panned = nav.constrain({ x: 180, y: 160, z: 1 });
    // The section label is 24px above its bounds; the top-left pill ends at 54px.
    expect(panned.y - 24).toBeGreaterThanOrEqual(54 + 16);
    expect(panned.x).toBeGreaterThanOrEqual(120);
  });

  it("fits a page so the topmost label clears the floating file controls", () => {
    for (const rect of [cluster, { x: 0, y: 0, w: 9000, h: 400 }]) {
      const nav = canvasNavigation([rect], desktop);
      // The file controls end 54px from the top; the label sits LABEL_ROOM above its node.
      expect(rect.y * nav.overview.z + nav.overview.y - LABEL_ROOM).toBeGreaterThanOrEqual(54 + 8);
    }
  });

  it("makes the fitted overview the furthest zoom out and locks panning at that overview", () => {
    const nav = canvasNavigation([cluster], desktop);
    expect(nav.minZoom).toBeCloseTo((desktop.h - 128 - LABEL_ROOM) / cluster.h);
    expectCamera(nav.fit([]), nav.overview);
    for (const x of [-1e10, 0, 1e10]) for (const y of [-1e10, 0, 1e10]) {
      expectCamera(nav.constrain({ x, y, z: 0.00001 }), nav.overview);
      expectCamera(nav.constrain({ x, y, z: nav.minZoom }), nav.overview);
    }
  });

  it("allows free panning above the fitted overview, including beyond the content edges", () => {
    const nav = canvasNavigation([cluster], desktop);
    for (const z of [nav.minZoom * 1.01, 0.5, 1, MAX_CANVAS_ZOOM]) {
      for (const x of [-1e10, 180, 1e10]) for (const y of [-1e10, 160, 1e10]) {
        expectCamera(nav.constrain({ x, y, z }), { x, y, z });
      }
    }
  });

  it("allows any part of a zoomed page to be centered, including corners", () => {
    const nav = canvasNavigation([cluster], desktop);
    for (const point of [{ x: cluster.x, y: cluster.y }, { x: cluster.x + cluster.w, y: cluster.y + cluster.h }, { x: 0, y: 1000 }]) {
      for (const z of [0.5, 1, 2]) {
        const next = nav.constrain({ x: desktop.w / 2 - point.x * z, y: desktop.h / 2 - point.y * z, z });
        expect(point.x * next.z + next.x).toBeCloseTo(desktop.w / 2);
        expect(point.y * next.z + next.y).toBeCloseTo(desktop.h / 2);
      }
    }
  });

  it("also frees the axis where a narrow cluster still fits once zoomed in", () => {
    const narrow = { x: 900, y: -500, w: 200, h: 5000 };
    const nav = canvasNavigation([narrow], { w: 1000, h: 800 });
    const requested = { x: 350, y: 250, z: 0.5 };
    expectCamera(nav.constrain(requested), requested);
  });

  it("keeps small designs at 100% in the overview and still allows zooming in", () => {
    const nav = canvasNavigation([{ x: 200, y: -100, w: 300, h: 200 }], desktop);
    expect(nav.minZoom).toBe(1);
    expectCamera(nav.constrain({ x: 1e10, y: -1e10, z: 0.1 }), nav.overview);
    expect(nav.constrain({ ...nav.overview, z: 2 }).z).toBe(2);
    expect(nav.constrain({ ...nav.overview, z: 1000 }).z).toBe(MAX_CANVAS_ZOOM);
  });

  it("allows zoomed touch panning and locks a pinch back to the overview", () => {
    const nav = canvasNavigation([cluster], desktop);
    const current = nav.constrain({ x: -500, y: -2000, z: 1 });
    const panned = applyTouch(current, { type: "pan", dx: 1e10, dy: -1e10 }, nav.minZoom, MAX_CANVAS_ZOOM);
    const bounded = nav.constrain(panned);
    expectCamera(bounded, panned);
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

  it("allows phone panning above the overview and restores its safe margins at Fit", () => {
    const nav = canvasNavigation([cluster], { w: 390, h: 844 });
    const requested = { x: 190, y: 300, z: 1 };
    expectCamera(nav.constrain(requested), requested);
    expectCamera(nav.constrain({ ...requested, z: nav.minZoom }), nav.overview);
    expect(cluster.y * nav.overview.z + nav.overview.y).toBeGreaterThanOrEqual(68 + LABEL_ROOM);
  });

  it("centers invalid saved offsets at the requested zoom without losing valid offsets", () => {
    const nav = canvasNavigation([cluster], desktop);
    const next = nav.constrain({ x: NaN, y: Infinity, z: 2 });
    expect((cluster.x + cluster.w / 2) * next.z + next.x).toBeCloseTo(desktop.w / 2);
    // Vertically, the centre of the area below the floating file controls and their label room.
    expect((cluster.y + cluster.h / 2) * next.z + next.y).toBeCloseTo(desktop.h / 2 + LABEL_ROOM / 2);
    expect(nav.constrain({ x: 180, y: NaN, z: 2 }).x).toBe(180);
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
