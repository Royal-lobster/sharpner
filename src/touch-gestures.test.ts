import { describe, expect, it } from "vitest";
import { applyTouch, TAP_MAX_MS, TouchNavigator, type Camera } from "./touch-gestures";

const cam: Camera = { x: 0, y: 0, z: 1 };
const world = (c: Camera, sx: number, sy: number) => ({ x: (sx - c.x) / c.z, y: (sy - c.y) / c.z });

describe("TouchNavigator", () => {
  it("treats a short still touch as a tap", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    expect(nav.move(1, 103, 102)).toEqual({ type: "none" });
    expect(nav.up(1, 120)).toEqual({ type: "tap", x: 100, y: 100 });
    expect(nav.active).toBe(false);
  });

  it("does not tap after a long press", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    expect(nav.up(1, TAP_MAX_MS + 1)).toEqual({ type: "none" });
  });

  it("pans past the slop without jumping, then follows the finger", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    expect(nav.move(1, 110, 100)).toEqual({ type: "pan", dx: 10, dy: 0 });
    expect(nav.move(1, 115, 90)).toEqual({ type: "pan", dx: 5, dy: -10 });
    expect(nav.panning).toBe(true);
    expect(nav.up(1, 50)).toEqual({ type: "none" });
  });

  it("pinches around the midpoint and keeps it under the fingers", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 200, 0);
    nav.down(2, 200, 200, 10);
    const action = nav.move(2, 300, 200);
    expect(action).toEqual({ type: "pinch", scale: 2, from: { x: 150, y: 200 }, to: { x: 200, y: 200 } });
    const next = applyTouch(cam, action, 0.01, 8);
    expect(next.z).toBe(2);
    // The world point that was under the old midpoint is now under the new one.
    expect(world(next, 200, 200)).toEqual(world(cam, 150, 200));
  });

  it("never taps once a second finger joined, even after both lift quickly", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    nav.down(2, 150, 100, 5);
    expect(nav.up(2, 20)).toEqual({ type: "none" });
    expect(nav.up(1, 30)).toEqual({ type: "none" });
  });

  it("hands a pinch over to a pan with the remaining finger, without a jump", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    nav.down(2, 200, 100, 0);
    nav.move(2, 220, 100);
    nav.up(2, 50);
    // The remaining finger continues from where it is: deltas only, no snap toward the old midpoint.
    expect(nav.move(1, 104, 100)).toEqual({ type: "pan", dx: 4, dy: 0 });
  });

  it("restarts the pinch baseline when a finger is replaced", () => {
    const nav = new TouchNavigator();
    nav.down(1, 0, 0, 0);
    nav.down(2, 100, 0, 0);
    nav.up(2, 10);
    nav.down(3, 0, 50, 20);
    // The new pair is 50px apart; moving to 100px is a 2x pinch, not relative to the old 100px pair.
    expect(nav.move(3, 0, 100)).toMatchObject({ type: "pinch", scale: 2 });
  });

  it("cancel commits nothing and leaves no stale fingers", () => {
    const nav = new TouchNavigator();
    nav.down(1, 10, 10, 0);
    expect(nav.cancel(1)).toEqual({ type: "none" });
    expect(nav.active).toBe(false);
    expect(nav.up(1, 20)).toEqual({ type: "none" });
    nav.down(4, 10, 10, 30);
    expect(nav.up(4, 40)).toEqual({ type: "tap", x: 10, y: 10 });
  });

  it("recovers when a finger's up event never arrived", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0, true);
    // Finger 1 lifted but the browser swallowed its pointerup. A new touch sequence starts:
    nav.down(2, 50, 50, 1000, true);
    expect(nav.move(2, 70, 50)).toEqual({ type: "pan", dx: 20, dy: 0 });
    expect(nav.up(2, 1100)).toEqual({ type: "none" });
    expect(nav.active).toBe(false);
    nav.down(3, 10, 10, 2000, true);
    expect(nav.up(3, 2050)).toEqual({ type: "tap", x: 10, y: 10 });
  });

  it("ignores moves for unknown pointers", () => {
    const nav = new TouchNavigator();
    expect(nav.move(9, 1, 1)).toEqual({ type: "none" });
  });

  it("recognizes double-tap without relying on browser compatibility mouse events", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0);
    expect(nav.up(1, 50)).toEqual({ type: "tap", x: 100, y: 100 });
    // Normal capture release after pointerup must not erase the first tap.
    nav.cancel(1);
    nav.down(2, 102, 101, 100);
    expect(nav.up(2, 150)).toEqual({ type: "doubletap", x: 102, y: 101 });
  });

  it("does not double-tap after a pan, pinch, a distant tap or a slow second tap", () => {
    const nav = new TouchNavigator();
    nav.down(1, 100, 100, 0); nav.up(1, 20);
    nav.down(2, 200, 200, 40);
    expect(nav.up(2, 60).type).toBe("tap");
    nav.down(3, 200, 200, 400);
    expect(nav.up(3, 420).type).toBe("tap");
    nav.down(4, 200, 200, 430); nav.move(4, 220, 200); nav.up(4, 450);
    nav.down(5, 200, 200, 460);
    expect(nav.up(5, 480).type).toBe("tap");
    nav.down(6, 200, 200, 490); nav.down(7, 300, 200, 500); nav.up(7, 510); nav.up(6, 520);
    nav.down(8, 200, 200, 530);
    expect(nav.up(8, 550).type).toBe("tap");
  });
});

describe("applyTouch", () => {
  it("clamps zoom and keeps the pinch point fixed at the limit", () => {
    const start = { x: 0, y: 0, z: 4 };
    const next = applyTouch(start, { type: "pinch", scale: 10, from: { x: 50, y: 50 }, to: { x: 50, y: 50 } }, 0.01, 8);
    expect(next.z).toBe(8);
    expect(world(next, 50, 50)).toEqual(world(start, 50, 50));
  });

  it("leaves the camera alone for taps", () => {
    expect(applyTouch(cam, { type: "tap", x: 1, y: 1 }, 0.01, 8)).toBe(cam);
  });
});
