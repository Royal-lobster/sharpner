import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PREVIEW_ANIMATION_BUDGET, PREVIEW_PACE_MESSAGE, previewAnimationShare, previewPacingScript } from "./preview-pacing";
import { frameDocument } from "./types";

/**
 * Runs the pacing script against a fake display. `frame()` advances one 16 ms display frame: it runs the
 * frame callbacks, spends `renderCost` ms rendering if an authored callback drew, then runs queued tasks.
 */
function pacedDocument(renderCost = 0) {
  let now = 0;
  let displayQueue: ((time: number) => void)[] = [];
  let tasks: (() => void)[] = [];
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const errors: unknown[] = [];
  const parent = {};
  class MessageChannel {
    port1: { onmessage: (() => void) | null } = { onmessage: null };
    port2 = { postMessage: () => tasks.push(() => this.port1.onmessage?.()) };
  }
  const context: Record<string, unknown> = {
    parent, MessageChannel,
    performance: { now: () => now },
    setTimeout: (callback: () => void) => { try { callback(); } catch (error) { errors.push(error); } },
    requestAnimationFrame: (callback: (time: number) => void) => { displayQueue.push(callback); return displayQueue.length; },
    addEventListener: (name: string, listener: (event: { source: unknown; data: unknown }) => void) => { if (name === "message") listeners.push(listener); },
  };
  context.globalThis = context;
  const script = previewPacingScript().replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  runInNewContext(script, context);
  const raf = context.requestAnimationFrame as (callback: (time: number) => void) => number;
  const cancel = context.cancelAnimationFrame as (id: number) => void;
  /** Main-thread time the document has used: callbacks plus rendering. */
  let busy = 0, drew = false;
  const frame = () => {
    now += 16;
    const due = displayQueue;
    displayQueue = [];
    drew = false;
    for (const callback of due) callback(now);
    if (drew) { now += renderCost; busy += renderCost; }
    const queued = tasks;
    tasks = [];
    for (const task of queued) task();
  };
  const post = (data: Record<string, unknown>, source: unknown = parent) => { for (const listener of listeners) listener({ source, data: { type: PREVIEW_PACE_MESSAGE, ...data } }); };
  /** An authored animation loop whose callback costs `cost` ms. */
  const loop = (cost: number) => {
    const ran: number[] = [];
    const step = (time: number) => { ran.push(time); drew = true; now += cost; busy += cost; raf(step); };
    raf(step);
    return ran;
  };
  return { raf, cancel, frame, post, loop, errors, share: () => busy / now };
}

describe("preview pacing", () => {
  it("runs a cheap animation on every display frame", () => {
    const doc = pacedDocument(0.1);
    doc.post({ paused: false, share: previewAnimationShare(1) });
    const ran = doc.loop(0.2);
    for (let i = 0; i < 60; i++) doc.frame();
    expect(ran.length).toBe(60);
  });

  it("holds an expensive animation, rendering included, to its share of the main thread", () => {
    // Each style frame of the chart prototypes took about 30 ms per animation frame, most of it rendering.
    const doc = pacedDocument(20);
    const share = previewAnimationShare(6);
    doc.post({ paused: false, share });
    const ran = doc.loop(10);
    for (let i = 0; i < 2000; i++) doc.frame();
    expect(doc.share()).toBeLessThanOrEqual(share * 1.1);
    expect(ran.length).toBeGreaterThan(20);
  });

  it("splits one budget among the live previews", () => {
    expect(previewAnimationShare(1)).toBe(PREVIEW_ANIMATION_BUDGET);
    expect(previewAnimationShare(6) * 6).toBeCloseTo(PREVIEW_ANIMATION_BUDGET);
    expect(previewAnimationShare(0)).toBe(PREVIEW_ANIMATION_BUDGET);
    const alone = pacedDocument(20), crowded = pacedDocument(20);
    alone.post({ paused: false, share: previewAnimationShare(1) });
    crowded.post({ paused: false, share: previewAnimationShare(6) });
    const one = alone.loop(10), many = crowded.loop(10);
    for (let i = 0; i < 2000; i++) { alone.frame(); crowded.frame(); }
    expect(one.length).toBeGreaterThan(many.length * 4);
  });

  it("pauses on the parent's message and resumes where it left off", () => {
    const doc = pacedDocument();
    doc.post({ paused: false, share: 1 });
    const ran = doc.loop(0.1);
    for (let i = 0; i < 3; i++) doc.frame();
    doc.post({ paused: true, share: 1 });
    for (let i = 0; i < 30; i++) doc.frame();
    expect(ran.length).toBe(3);
    doc.post({ paused: false, share: 1 });
    doc.frame();
    doc.frame();
    expect(ran.length).toBe(5);
  });

  it("draws its first frames before holding a document paused from load", () => {
    // A preview goes live as the camera settles; if it moves again before the design's first frame, the design
    // must still draw, or its empty view covers the thumbnail until the camera stops.
    const doc = pacedDocument(20);
    doc.post({ paused: true, share: previewAnimationShare(6) });
    const ran = doc.loop(80);
    for (let i = 0; i < 30; i++) doc.frame();
    expect(ran.length).toBe(2);
  });

  it("ignores pace messages from anything but the parent, and shares it cannot use", () => {
    const doc = pacedDocument();
    doc.post({ paused: false, share: 1 });
    const ran = doc.loop(0.1);
    doc.post({ paused: true, share: 1 }, {});
    doc.post({ paused: false, share: 0 });
    doc.post({ paused: false, share: Number.NaN });
    for (let i = 0; i < 5; i++) doc.frame();
    expect(ran.length).toBe(5);
  });

  it("cancels requests and keeps other callbacks running when one throws", () => {
    const doc = pacedDocument();
    const ran: string[] = [];
    const cancelled = doc.raf(() => ran.push("cancelled"));
    doc.raf(() => { throw new Error("authored bug"); });
    doc.raf(() => ran.push("after"));
    doc.cancel(cancelled);
    doc.frame();
    expect(ran).toEqual(["after"]);
    expect(doc.errors).toEqual([new Error("authored bug")]);
  });
});

describe("paced documents", () => {
  it("installs pacing before authored scripts in live previews only", () => {
    for (const html of ["<main><script>requestAnimationFrame(draw)</script></main>", "<!doctype html><html><head><script>requestAnimationFrame(draw)</script></head><body></body></html>"]) {
      const live = frameDocument(html, { measure: true, pace: true, base: "https://sharpner.test" });
      expect(live.indexOf("data-sharpner-pacing")).toBeGreaterThan(0);
      expect(live.indexOf("data-sharpner-pacing")).toBeLessThan(live.indexOf("requestAnimationFrame(draw)"));
      // Thumbnails and screenshots render the same document without it, so their output does not change.
      expect(frameDocument(html, { measure: true, base: "https://sharpner.test" })).not.toContain("data-sharpner-pacing");
    }
  });
});
