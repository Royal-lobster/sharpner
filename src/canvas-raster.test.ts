import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutHeight, layoutRects } from "../shared/layout";
import type { CanvasNode } from "../shared/types";
import { paintRaster } from "./Canvas";
import { planCanvasRendering } from "./canvas-render-plan";
import { ThumbnailCache } from "./thumbnail-cache";

const component: CanvasNode = {
  id: "button", pageId: "page", parentId: null, kind: "component", name: "Button/Primary",
  x: 0, y: 0, width: 180, height: 184, measuredHeight: null, src: null,
  thumbLo: "/button-256.webp", thumbHi: "/button-1280.webp", rev: 1,
};

function fixture(options: ConstructorParameters<typeof ThumbnailCache>[1] = {}) {
  vi.stubGlobal("devicePixelRatio", 2);
  const drawImage = vi.fn();
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), drawImage,
    beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 7, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 }) };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const images: { src: string; onload: (() => void) | null }[] = [];
  const cache = new ThumbnailCache(vi.fn(), {
    createImage: () => {
      const image = { src: "", onload: null, onerror: null, naturalWidth: 256, naturalHeight: 262, removeAttribute: vi.fn() };
      images.push(image);
      return image as unknown as HTMLImageElement;
    },
    ...options,
  });
  const highImages: { src: string; onload: (() => void) | null }[] = [];
  const highCache = new ThumbnailCache(vi.fn(), {
    maxEntries: 32, maxPixels: 32 * 1024 * 1024, maxConcurrent: 2,
    createImage: () => {
      const image = { src: "", onload: null, onerror: null, naturalWidth: 1280, naturalHeight: 1308, removeAttribute: vi.fn() };
      highImages.push(image);
      return image as unknown as HTMLImageElement;
    },
  });
  const paint = (zoom: number, nodes = [component], upgrades = { enabled: false, settled: true }) => {
    const camera = { x: 0, y: 0, z: zoom }, size = { w: 1000, h: 800 };
    const plan = planCanvasRendering(nodes, layoutRects(nodes, layoutHeight), {
      camera, size, pixelRatio: 2, ready: true, settled: true,
      previous: { liveIds: new Set(), imageIds: new Set() },
    });
    paintRaster(canvas, size, camera, plan.sections, plan.rasterFrames, new Set(), new Map(), new Set(), [], {
      agent: new Map(), done: new Map(), appeared: new Map(), now: 0, reducedMotion: true,
    }, cache, { cache: highCache, ...upgrades });
    return plan;
  };
  return { paint, cache, images, highCache, highImages, drawImage, fillText: ctx.fillText,
    finish: () => images.forEach(image => image.onload?.()),
    finishHigh: () => highImages.forEach(image => image.onload?.()),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("raster previews while zoomed out", () => {
  it("admits a stable sharper working set using the renderer's actual maximum image size", () => {
    const f = fixture();
    const nodes = Array.from({ length: 32 }, (_, i) => ({
      ...component, id: String(i), width: 400, height: 800,
      x: (i % 8) * 420, y: Math.floor(i / 8) * 850,
      thumbLo: `/small-${i}.webp`, thumbHi: `/sharp-${i}.webp`,
    }));
    const upgrades = { enabled: true, settled: true };
    f.paint(0.2, nodes, upgrades);
    f.finish(); f.finish();
    f.paint(0.2, nodes, upgrades);
    // These previews are 400x800, not upscaled 1280px captures. All 32 fit the existing budget.
    expect(f.highCache.stats.admitted).toBe(32);
    expect(f.highCache.stats.loading).toBe(2);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("sharpens a visible component before the DOM threshold without waiting for more zoom", () => {
    const f = fixture();
    const upgrades = { enabled: true, settled: true };
    const plan = f.paint(0.5, [component], upgrades);
    expect(plan.domFrames).toEqual([]);
    expect(plan.liveIds.size).toBe(0);
    expect(f.highImages).toEqual([]);
    f.finish();
    f.paint(0.5, [component], upgrades);
    expect(f.highImages.map(image => image.src)).toEqual([component.thumbHi]);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    f.finishHigh();
    f.paint(0.5, [component], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.highImages[0]);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("keeps a node's previous preview on screen until the restyled one loads", () => {
    const f = fixture();
    const upgrades = { enabled: false, settled: true };
    f.paint(0.5, [component], upgrades);
    f.finish();
    f.paint(0.5, [component], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    const restyled = { ...component, rev: 2, thumbRev: 2, thumbLo: "/button-dark-256.webp", thumbHi: "/button-dark-1280.webp" };
    f.drawImage.mockClear();
    f.paint(0.5, [restyled], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    f.finish();
    f.paint(0.5, [restyled], upgrades);
    expect(f.images.at(-1)!.src).toBe(restyled.thumbLo);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images.at(-1));
    f.cache.dispose(); f.highCache.dispose();
  });

  it.each([{ enabled: false, settled: true }, { enabled: true, settled: false }])("keeps optional upgrades paused for %j", upgrades => {
    const f = fixture();
    f.paint(0.5, [component], upgrades);
    f.finish();
    f.paint(0.5, [component], upgrades);
    expect(f.highImages).toEqual([]);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("bounds background requests and never prefetches original uploads or offscreen previews", () => {
    const f = fixture();
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      ...component, id: String(i), x: i * 200, thumbLo: `/lo-${i}.webp`, thumbHi: `/hi-${i}.webp`,
    }));
    nodes.push({ ...component, id: "nearby", x: 2200, thumbLo: "/offscreen-lo.webp", thumbHi: "/offscreen-hi.webp" });
    nodes.push({ ...component, id: "upload", kind: "image", src: "/original.jpg", thumbLo: "/upload-lo.webp", thumbHi: "/original.jpg" });
    const upgrades = { enabled: true, settled: true };
    f.paint(0.5, nodes, upgrades); f.finish(); f.paint(0.5, nodes, upgrades);
    expect(f.highImages).toHaveLength(2);
    expect(f.highCache.stats.loading).toBe(2);
    for (let i = 0; i < 4; i++) { f.finishHigh(); f.paint(0.5, nodes, upgrades); }
    expect(f.highImages).toHaveLength(8);
    expect(f.highImages.every(image => image.src.startsWith("/hi-"))).toBe(true);
    expect(f.highCache.stats.loading).toBe(0);
    expect(f.highCache.stats.decodedPixels).toBeLessThanOrEqual(32 * 1024 * 1024);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("keeps drawing a loaded low-resolution preview below 40px without loading it again", () => {
    const f = fixture();
    f.paint(0.4);
    expect(f.images.map(image => image.src)).toEqual([component.thumbLo]);
    f.finish();
    f.paint(0.4);
    expect(f.drawImage).toHaveBeenCalledTimes(1);

    f.drawImage.mockClear();
    const plan = f.paint(0.1);
    expect(plan.rasterFrames).toHaveLength(1);
    expect(plan.liveIds.size).toBe(0);
    expect(f.drawImage).toHaveBeenCalledTimes(1);
    expect(f.images).toHaveLength(1);
    f.cache.dispose();
  });

  it.each([0.2, 0.1, 0.01])("loads and paints the small preview when a page opens at %s zoom", zoom => {
    const f = fixture();
    const plan = f.paint(zoom);
    expect(plan.domFrames).toEqual([]);
    expect(f.images.map(image => image.src)).toEqual([component.thumbLo]);
    f.finish();
    f.paint(zoom);
    expect(f.drawImage).toHaveBeenCalledTimes(1);
    expect(f.cache.stats.loading).toBe(0);
    f.cache.dispose();
  });
});

describe("raster labels", () => {
  const flow: CanvasNode = { ...component, id: "flow", kind: "section", name: "Checkout", layout: "auto", width: 0, height: null, thumbLo: null, thumbHi: null };
  const screens = Array.from({ length: 6 }, (_, i): CanvasNode => ({
    ...component, id: `s${i}`, kind: "frame", name: `Screen ${i}`, parentId: "flow", order: i, width: 400, height: 800, thumbLo: null, thumbHi: null,
  }));
  const labels = (f: ReturnType<typeof fixture>) => f.fillText.mock.calls.map(([text]) => text as string);

  it("hides nested labels together once the row gap can't hold them, even where the section padding still could", () => {
    const f = fixture();
    // Ten 700px screens wrap into two rows. At 17.5% the 128px padding fits a label but the 120px row gap does not.
    const wide = Array.from({ length: 10 }, (_, i) => ({ ...screens[0]!, id: `w${i}`, name: `Wide ${i}`, order: i, width: 700, height: 600 }));
    f.paint(0.175, [flow, ...wide]);
    expect(labels(f)).toEqual(["Checkout"]);
    f.fillText.mockClear();
    f.paint(0.19, [flow, ...wide]);
    expect(labels(f)).toEqual([...wide.map(s => s.name), "Checkout"]);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("cuts long names to the node's on-screen width", () => {
    const f = fixture();
    f.paint(0.3, [flow, ...screens.map(s => ({ ...s, name: `${s.name} with a long descriptive name` }))]);
    // 400px at 30% leaves 120px, about 17 characters at the mock's 7px per character.
    for (const text of labels(f).slice(0, -1)) {
      expect(text.endsWith("…")).toBe(true);
      expect(text.length * 7).toBeLessThanOrEqual(120);
    }
    f.cache.dispose(); f.highCache.dispose();
  });
});
