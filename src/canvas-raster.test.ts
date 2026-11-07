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
  const paint = (zoom: number, nodes = [component], upgrades = { enabled: false, settled: true }, rects = layoutRects(nodes, layoutHeight)) => {
    const camera = { x: 0, y: 0, z: zoom }, size = { w: 1000, h: 800 };
    const plan = planCanvasRendering(nodes, rects, {
      camera, size, pixelRatio: 2, ready: true, settled: true,
      previous: { liveIds: new Set(), imageIds: new Set() },
    });
    paintRaster(canvas, size, camera, plan.sections, plan.rasterFrames, new Set(), new Map(), new Set(), { labels: [], tables: [], cells: new Set() }, {
      agent: new Map(), done: new Map(), appeared: new Map(), now: 0, reducedMotion: true,
    }, cache, { cache: highCache, ...upgrades });
    return plan;
  };
  return { paint, cache, images, highCache, highImages, drawImage, ctx: ctx as { globalAlpha?: number }, fillText: ctx.fillText,
    finish: () => images.forEach(image => image.onload?.()),
    finishHigh: () => highImages.forEach(image => image.onload?.()),
  };
}

afterEach(() => vi.unstubAllGlobals());

/** Rects at each node's own x/y, for tests that need nodes at chosen places on screen rather than in page layout. */
const placed = (nodes: CanvasNode[]) => new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.width, h: layoutHeight(n) }]));

describe("raster previews while zoomed out", () => {
  it("admits a stable sharper working set using the renderer's actual maximum image size", () => {
    const f = fixture();
    const nodes = Array.from({ length: 32 }, (_, i) => ({
      ...component, id: String(i), width: 400, height: 800,
      x: (i % 8) * 420, y: Math.floor(i / 8) * 850,
      thumbLo: `/small-${i}.webp`, thumbHi: `/sharp-${i}.webp`,
    }));
    const upgrades = { enabled: true, settled: true }, rects = placed(nodes);
    f.paint(0.2, nodes, upgrades, rects);
    f.finish(); f.finish();
    f.paint(0.2, nodes, upgrades, rects);
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
    const alphas: number[] = [];
    f.drawImage.mockClear();
    f.drawImage.mockImplementation(() => { alphas.push(f.ctx.globalAlpha ?? 1); });
    f.paint(0.5, [restyled], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    // The new revision's preview exists but has not loaded: the old pixels stay up, dimmed, as an outdated preview does.
    f.paint(0.5, [restyled], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images[0]);
    f.finish();
    f.paint(0.5, [restyled], upgrades);
    expect(f.images.at(-1)!.src).toBe(restyled.thumbLo);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(f.images.at(-1));
    expect(alphas).toEqual([0.45, 0.45, 1]);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("draws decoded bitmaps and skips a kept preview once the cache has closed it", () => {
    const bitmaps: { width: number; height: number; close: () => void }[] = [];
    const deliveries: (() => void)[] = [];
    // A one-entry budget evicts the previous preview while its restyled replacement loads.
    const f = fixture({ maxEntries: 1, loadImage: (_image, _url, decoded) => {
      const bitmap = { width: 256, height: 262, close() { bitmap.width = bitmap.height = 0; } };
      bitmaps.push(bitmap);
      deliveries.push(() => decoded(bitmap as unknown as ImageBitmap));
      return () => {};
    } });
    // Like a browser, refuse to draw a closed bitmap.
    f.drawImage.mockImplementation((image: { width: number }) => {
      if (!image.width) throw new DOMException("The image source is detached", "InvalidStateError");
    });
    const upgrades = { enabled: false, settled: true };
    f.paint(0.5, [component], upgrades);
    deliveries.shift()!();
    f.paint(0.5, [component], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(bitmaps[0]);
    expect(f.drawImage.mock.lastCall?.slice(1, 4)).toEqual([0, 0, 256]);
    const restyled = { ...component, rev: 2, thumbRev: 2, thumbLo: "/button-dark-256.webp", thumbHi: "/button-dark-1280.webp" };
    f.drawImage.mockClear();
    expect(() => f.paint(0.5, [restyled], upgrades)).not.toThrow();
    expect(bitmaps[0]!.width).toBe(0);
    expect(f.drawImage).not.toHaveBeenCalled();
    deliveries.shift()!();
    f.paint(0.5, [restyled], upgrades);
    expect(f.drawImage.mock.lastCall?.[0]).toBe(bitmaps[1]);
    f.cache.dispose(); f.highCache.dispose();
  });

  it("dims a preview that trails its node's revision until the re-render arrives", () => {
    const f = fixture();
    const upgrades = { enabled: false, settled: true };
    const alphas: number[] = [];
    f.drawImage.mockImplementation(() => { alphas.push(f.ctx.globalAlpha ?? 1); });
    f.paint(0.5, [component], upgrades);
    f.finish();
    f.paint(0.5, [{ ...component, rev: 2, thumbRev: 1 }], upgrades);
    f.paint(0.5, [{ ...component, rev: 2, thumbRev: 2 }], upgrades);
    expect(alphas).toEqual([0.45, 1]);
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
    const upgrades = { enabled: true, settled: true }, rects = placed(nodes);
    f.paint(0.5, nodes, upgrades, rects); f.finish(); f.paint(0.5, nodes, upgrades, rects);
    expect(f.highImages).toHaveLength(2);
    expect(f.highCache.stats.loading).toBe(2);
    for (let i = 0; i < 4; i++) { f.finishHigh(); f.paint(0.5, nodes, upgrades, rects); }
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
  const flow: CanvasNode = { ...component, id: "flow", kind: "section", name: "Checkout", width: 0, height: null, thumbLo: null, thumbHi: null };
  const screens = Array.from({ length: 6 }, (_, i): CanvasNode => ({
    ...component, id: `s${i}`, kind: "frame", name: `Screen ${i}`, parentId: "flow", order: i, width: 400, height: 800, thumbLo: null, thumbHi: null,
  }));
  const labels = (f: ReturnType<typeof fixture>) => f.fillText.mock.calls.map(([text]) => text as string);

  it("moves nested labels inside their nodes together once the row gap can't hold them, even where the section padding still could", () => {
    const f = fixture();
    // Ten 700px screens wrap into two rows. At 17.5% the 128px padding fits a label but the 120px row gap does not.
    const wide = Array.from({ length: 10 }, (_, i) => ({ ...screens[0]!, id: `w${i}`, name: `Wide ${i}`, order: i, width: 700, height: 600 }));
    f.paint(0.175, [flow, ...wide]);
    // Every name is still painted, each as a chip on a scrim inside its screen.
    expect(labels(f)).toEqual([...wide.map(s => s.name), "Checkout"]);
    const inside = f.fillText.mock.calls.slice(0, wide.length).map(([, , y]) => y as number);
    f.fillText.mockClear();
    f.paint(0.19, [flow, ...wide]);
    expect(labels(f)).toEqual([...wide.map(s => s.name), "Checkout"]);
    const above = f.fillText.mock.calls.slice(0, wide.length).map(([, , y]) => y as number);
    // A chip sits below its screen's top edge; a label above sits over it.
    inside.forEach((y, i) => expect(y).toBeGreaterThan(above[i]! * 0.175 / 0.19));
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
