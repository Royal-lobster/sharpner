/**
 * Touch navigation for the canvas. Touch never moves or deletes nodes: one finger pans, two fingers
 * pinch-zoom around their midpoint, and a short still tap selects (or clears) for agents to see.
 * Pure state machine so transitions (pan → pinch → pan, cancel) can be tested without a DOM.
 */

/** screen = world * z + (x, y) */
export type Camera = { x: number; y: number; z: number };
type Point = { x: number; y: number };

export type TouchAction =
  | { type: "none" }
  | { type: "pan"; dx: number; dy: number }
  /** Scale about `from`, then carry that point to `to`. */
  | { type: "pinch"; scale: number; from: Point; to: Point }
  | { type: "tap"; x: number; y: number }
  | { type: "doubletap"; x: number; y: number };

const NONE: TouchAction = { type: "none" };
/** Finger travel (CSS px) that turns a touch from a tap into a pan. */
export const TAP_SLOP = 8;
/** A touch held longer than this is not a tap (lets people rest a finger without selecting). */
export const TAP_MAX_MS = 500;

export class TouchNavigator {
  private points = new Map<number, Point>();
  /** The first finger of a gesture, while it can still become a tap. */
  private tap: { id: number; x: number; y: number; at: number } | null = null;
  private moved = false;
  private pinch: { mid: Point; dist: number } | null = null;
  private previousTap: (Point & { at: number }) | null = null;

  get active() { return this.points.size > 0; }
  get panning() { return this.moved || this.pinch !== null; }

  /**
   * `primary` marks the first finger of a new touch sequence (PointerEvent.isPrimary). Any fingers
   * still tracked then are stale: their up/cancel never arrived (iOS can drop them during system
   * gestures), and keeping them would turn every later touch into a broken pinch.
   */
  down(id: number, x: number, y: number, now: number, primary = this.points.size === 0): TouchAction {
    if (primary) {
      if (this.points.size) this.previousTap = null;
      this.reset();
    }
    this.points.set(id, { x, y });
    if (this.points.size === 1) {
      this.tap = { id, x, y, at: now };
      this.moved = false;
      this.pinch = null;
    } else {
      // A second finger ends any chance of a tap and starts a pinch from the current two contacts.
      this.tap = null;
      this.previousTap = null;
      this.pinch = this.measure();
    }
    return NONE;
  }

  move(id: number, x: number, y: number): TouchAction {
    const p = this.points.get(id);
    if (!p) return NONE;
    const last = { ...p };
    p.x = x; p.y = y;
    if (this.points.size >= 2) {
      const next = this.measure();
      const prev = this.pinch;
      this.pinch = next;
      if (!prev || !next) return NONE;
      return { type: "pinch", scale: prev.dist > 0 ? next.dist / prev.dist : 1, from: prev.mid, to: next.mid };
    }
    if (!this.moved) {
      const origin = this.tap && this.tap.id === id ? this.tap : last;
      if (Math.hypot(x - origin.x, y - origin.y) < TAP_SLOP) return NONE;
      this.moved = true;
      this.tap = null;
      this.previousTap = null;
      return { type: "pan", dx: x - origin.x, dy: y - origin.y };
    }
    return { type: "pan", dx: x - last.x, dy: y - last.y };
  }

  up(id: number, now: number): TouchAction {
    if (!this.points.delete(id)) return NONE;
    const tap = this.tap;
    if (this.points.size === 0) {
      this.reset();
      if (tap && tap.id === id && now - tap.at <= TAP_MAX_MS) {
        // Native touch cancellation suppresses compatibility mouse dblclick; keep double-tap explicit.
        const previous = this.previousTap;
        this.previousTap = { x: tap.x, y: tap.y, at: now };
        if (previous && now - previous.at <= 300 && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= 24) {
          this.previousTap = null;
          return { type: "doubletap", x: tap.x, y: tap.y };
        }
        return { type: "tap", x: tap.x, y: tap.y };
      }
      return NONE;
    }
    // Lifting one finger of a pinch hands over to a pan with the remaining finger, without a jump.
    this.pinch = this.points.size >= 2 ? this.measure() : null;
    this.moved = true;
    return NONE;
  }

  /** The browser took the touch (scroll, system gesture). Nothing is committed. */
  cancel(id: number): TouchAction {
    // Capture is also released after every normal pointerup; an already-ended finger changes nothing.
    if (!this.points.delete(id)) return NONE;
    this.tap = null;
    this.previousTap = null;
    if (this.points.size === 0) this.reset();
    else this.pinch = this.points.size >= 2 ? this.measure() : null;
    return NONE;
  }

  private measure() {
    const [a, b] = [...this.points.values()];
    if (!a || !b) return null;
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private reset() {
    this.points.clear();
    this.tap = null;
    this.moved = false;
    this.pinch = null;
  }
}

/** Applies a pan or pinch to a camera, clamping zoom while keeping the pinch point under the fingers. */
export function applyTouch(cam: Camera, action: TouchAction, minZ: number, maxZ: number): Camera {
  if (action.type === "pan") return { ...cam, x: cam.x + action.dx, y: cam.y + action.dy };
  if (action.type !== "pinch") return cam;
  const z = Math.min(maxZ, Math.max(minZ, cam.z * action.scale));
  const k = z / cam.z;
  return { z, x: action.to.x - (action.from.x - cam.x) * k, y: action.to.y - (action.from.y - cam.y) * k };
}
