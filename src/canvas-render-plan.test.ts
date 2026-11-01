import { describe, expect, it } from "vitest";
import { layoutHeight, layoutRects } from "../shared/layout";
import type { CanvasNode } from "../shared/types";
import { canInteract, planCanvasRendering } from "./canvas-render-plan";

const node = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 400, measuredHeight: null, src: null,
  thumbLo: "/preview.webp", thumbHi: "/preview-large.webp", rev: 1, ...overrides,
});
const viewport = {
  camera: { x: 0, y: 0, z: 1 }, size: { w: 1000, h: 800 }, pixelRatio: 1,
  ready: true, settled: true,
  previous: { liveIds: new Set<string>(), imageIds: new Set<string>() },
};
function plan(nodes: CanvasNode[], overrides: Partial<typeof viewport> & { interactionId?: string | null } = {}) {
  return planCanvasRendering(nodes, layoutRects(nodes, layoutHeight), { ...viewport, ...overrides });
}
const ids = (nodes: { node: CanvasNode }[]) => nodes.map(({ node }) => node.id);

describe("canvas render plan", () => {
  it("adds the played design to the live set without suspending other live previews", () => {
    const result = plan([node("playing", { width: 80 }), node("ordinary")], { interactionId: "playing" });
    expect(result.liveIds).toEqual(new Set(["playing", "ordinary"]));
  });

  it("keeps the played design mounted when panned away, so its input state survives", () => {
    const result = plan([node("active", { x: 5000 }), node("inactive", { x: 5000 })], { interactionId: "active" });
    expect(ids(result.domFrames)).toEqual(["active"]);
    expect([...result.liveIds]).toEqual(["active"]);
  });

  it("only plays frames and components that exist", () => {
    expect(plan([node("other")], { interactionId: "deleted" }).liveIds).toEqual(new Set(["other"]));
    for (const kind of ["tokens", "image", "section"] as const) expect(canInteract(node("bad", { kind }))).toBe(false);
    expect(canInteract(node("screen"))).toBe(true);
    expect(canInteract(node("button", { kind: "component" }))).toBe(true);
  });

  it("waits for the opening camera before promoting sources or originals", () => {
    const result = plan([node("frame"), node("image", { kind: "image" })], {
      ready: false,
      previous: { liveIds: new Set(["frame"]), imageIds: new Set(["image"]) },
    });
    expect(result.domFrames).toEqual([]);
    expect(result.rasterFrames).toEqual([]);
    expect(result.liveIds.size).toBe(0);
    expect(result.imageIds.size).toBe(0);
  });

  it("prefetches the viewport margin without promoting offscreen content", () => {
    const result = plan([
      node("visible"),
      node("nearby", { x: 1100 }),
      node("far-away", { x: 2000 }),
    ]);
    expect(ids(result.domFrames)).toEqual(["visible", "nearby"]);
    expect([...result.liveIds]).toEqual(["visible"]);
    expect(result.domFrames[1]!.visibleArea).toBe(0);
  });

  it("budgets frames with and without previews separately, preferring visible area", () => {
    const frames = Array.from({ length: 8 }, (_, i) => node(`preview-${i}`, { height: 400 + i }));
    const missing = Array.from({ length: 15 }, (_, i) => node(`missing-${i}`, { thumbHi: null }));
    const result = plan([...frames, ...missing]);
    expect([...result.liveIds]).toEqual([
      "preview-7", "preview-6", "preview-5", "preview-4", "preview-3", "preview-2",
      ...missing.slice(0, 12).map(node => node.id),
    ]);
    expect(result.liveIds.size).toBe(18);
  });

  it("renders screens live while their previews still show an earlier revision, such as the previous theme", () => {
    const result = plan([
      node("restyled", { width: 200, rev: 3, thumbRev: 2 }),
      node("current", { width: 200, rev: 3, thumbRev: 3 }),
      node("legacy", { width: 200, rev: 3 }),
    ]);
    expect([...result.liveIds]).toEqual(["restyled"]);
  });

  it("allows compact component specimens and missing previews to become live earlier", () => {
    const result = plan([
      node("component", { kind: "component", width: 220 }),
      node("small-frame", { width: 220 }),
      node("no-preview", { width: 140, thumbHi: null }),
      node("too-small", { width: 139, thumbHi: null }),
    ]);
    expect([...result.liveIds]).toEqual(["component", "no-preview"]);
    expect(ids(result.domFrames)).toEqual(["component", "no-preview"]);
  });

  it("keeps eligible live content during motion without promoting new content", () => {
    const result = plan([
      node("old-frame"), node("new-frame"), node("gone-frame", { x: 5000 }),
      node("old-image", { kind: "image" }), node("new-image", { kind: "image" }),
    ], {
      settled: false,
      previous: { liveIds: new Set(["old-frame", "gone-frame"]), imageIds: new Set(["old-image"]) },
    });
    expect([...result.liveIds]).toEqual(["old-frame"]);
    expect([...result.imageIds]).toEqual(["old-image"]);
    expect(ids(result.rasterFrames)).toEqual(["new-image"]);
  });

  it("loads at most eight original images and leaves the rest on the raster layer", () => {
    const images = Array.from({ length: 12 }, (_, i) => node(`image-${i}`, { kind: "image", height: 400 + i }));
    const result = plan(images);
    expect([...result.imageIds]).toEqual(images.slice(4).reverse().map(node => node.id));
    expect(ids(result.rasterFrames)).toEqual(images.slice(0, 4).map(node => node.id));
    expect(result.liveIds.size).toBe(0);
  });

  it("uses device pixels for previews and CSS pixels for live source eligibility", () => {
    const result = plan([node("small-frame", { width: 150 })], { pixelRatio: 2 });
    expect(ids(result.domFrames)).toEqual(["small-frame"]);
    expect(result.liveIds.size).toBe(0);
  });

  it("paints nested sections above their parents and keeps sections out of live content", () => {
    const result = plan([
      node("inner", { kind: "section", parentId: "outer", width: 200, height: 200 }),
      node("outer", { kind: "section", width: 1000, height: 800 }),
    ]);
    expect(ids(result.sections)).toEqual(["outer", "inner"]);
    expect(result.domFrames).toEqual([]);
    expect(result.rasterFrames).toEqual([]);
    expect(result.liveIds.size).toBe(0);
  });
});
