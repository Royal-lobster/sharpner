import { describe, expect, it } from "vitest";
import { canvasGestureBoundary } from "./canvas-gesture-boundary";

function fixture() {
  const view = new EventTarget();
  const doc = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const control = { closest: () => control };
  const outside = { closest: () => null };
  const root = Object.assign(new EventTarget(), {
    ownerDocument: doc, contains: (node: unknown) => node === root || node === control, closest: () => null,
  });
  const cleanup = canvasGestureBoundary(root as unknown as HTMLElement);
  const event = (type: string, target: unknown, touches: unknown[] = [target]) => {
    const e = new Event(type, { cancelable: true, bubbles: true });
    Object.defineProperties(e, { target: { value: target }, touches: { value: touches.map((target) => ({ target })) } });
    // Native capture traverses the document before reaching the element.
    doc.dispatchEvent(e);
    if (root.contains(target)) root.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { event, root, outside, control, view, cleanup };
}

describe("canvas native gesture boundary", () => {
  it("cancels browser pan/pinch from the first canvas touch through leaving the surface", () => {
    const { event, root, outside } = fixture();
    expect(event("touchstart", root)).toBe(true);
    expect(event("touchmove", root)).toBe(true);
    expect(event("touchmove", outside, [root])).toBe(true);
    expect(event("touchstart", outside, [root, outside])).toBe(true);
    expect(event("gesturechange", outside)).toBe(true);
    event("touchend", outside, []);
    expect(event("touchmove", outside)).toBe(false);
  });

  it("preserves control clicks and scrolling/pinching that begins in menus or other pages", () => {
    const { event, root, outside, control } = fixture();
    expect(event("touchstart", control)).toBe(false);
    expect(event("touchmove", control)).toBe(false);
    expect(event("touchstart", outside)).toBe(false);
    expect(event("touchmove", outside)).toBe(false);
    expect(event("gesturechange", outside)).toBe(false);
    // A menu gesture drifting over the canvas does not become a canvas gesture.
    expect(event("touchmove", root, [outside])).toBe(false);
  });

  it("cancels Safari gesture defaults over the surface without requiring a touch event", () => {
    const { event, root, outside } = fixture();
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) expect(event(type, root)).toBe(true);
    expect(event("gesturestart", outside)).toBe(false);
  });

  it("recovers when a new touch starts outside after the old end event was lost", () => {
    const { event, root, outside } = fixture();
    event("touchstart", root);
    expect(event("touchstart", outside)).toBe(false);
    expect(event("touchmove", outside)).toBe(false);
  });

  it("releases gesture ownership on cancellation, blur, and unmount", () => {
    const { event, root, outside, view, cleanup } = fixture();
    event("touchstart", root);
    event("touchcancel", root, []);
    expect(event("touchmove", outside)).toBe(false);
    event("touchstart", root);
    view.dispatchEvent(new Event("blur"));
    expect(event("touchmove", outside)).toBe(false);
    event("touchstart", root);
    cleanup();
    expect(event("touchstart", root)).toBe(false);
    expect(event("touchmove", outside)).toBe(false);
    expect(event("gesturechange", root)).toBe(false);
  });
});
