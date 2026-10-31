import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewLoader } from "./preview-loader";
import { ThumbnailCache } from "./thumbnail-cache";

const file = "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437";
const url = (i: number, fileId = file) => `/a/${fileId}/t/00000000-0000-4000-8000-${String(i).padStart(12, "0")}-1-lo.webp`;
class Image {
  dataset: Record<string, string> = {};
  src = "";
  decoding = ""; fetchPriority = "";
  naturalWidth = 256; naturalHeight = 256;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute() { this.src = ""; }
}
const image = () => new Image() as unknown as HTMLImageElement;
const fetcher = vi.fn<typeof fetch>();
let loader: PreviewLoader;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async (input) => {
    const request = new URL(String(input), "https://sharpner.example");
    const fileId = request.pathname.split("/")[2]!;
    return Response.json({ previews: request.searchParams.get("items")!.split(",").map((name) => ({
      url: `/a/${fileId}/t/${name}`, data: btoa("preview"),
    })) });
  });
  loader = new PreviewLoader();
});
afterEach(() => { loader.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("canvas preview batches", () => {
  it("keeps batch URLs stable when paint priority and image completion order change", async () => {
    const urls = Array.from({ length: 32 }, (_, i) => url(i));
    loader.prepare(urls);
    loader.load(image(), url(0));
    loader.load(image(), url(20));
    await vi.advanceTimersByTimeAsync(10);
    const first = fetcher.mock.calls.map(([request]) => String(request)).sort();
    loader.dispose();
    loader = new PreviewLoader();
    fetcher.mockClear();
    loader.prepare([...urls].reverse());
    loader.load(image(), url(20));
    loader.load(image(), url(0));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher.mock.calls.map(([request]) => String(request)).sort()).toEqual(first);
  });

  it("loads a real 159-preview cache working set in ten requests while retaining every image", async () => {
    const images: Image[] = [];
    const cache = new ThumbnailCache(() => {}, { loadImage: loader.load, prepareImages: loader.prepare, createImage: () => {
      const img = new Image(); images.push(img); return img as unknown as HTMLImageElement;
    } });
    cache.setViewport(Array.from({ length: 159 }, (_, i) => ({ url: url(i), priority: 159 - i })));
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10);
      for (const img of images.filter((img) => img.src && img.onload)) img.onload?.();
    }
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(images).toHaveLength(159);
    expect(cache.stats.loading).toBe(0);
    expect(cache.stats.queued).toBe(0);
    for (let i = 0; i < 159; i++) {
      const img = cache.get(url(i));
      expect(img?.src).toBe(`data:image/webp;base64,${btoa("preview")}`);
      expect(img?.dataset.previewSrc).toBe(url(i));
    }
    cache.dispose();
  });

  it("keeps at most four sixteen-image batches in flight and starts queued work only after one completes", async () => {
    const responses: ((response: Response) => void)[] = [];
    fetcher.mockImplementation(() => new Promise((resolve) => responses.push(resolve)));
    loader.prepare(Array.from({ length: 80 }, (_, i) => url(i)));
    for (let i = 0; i < 80; i++) loader.load(image(), url(i));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const call of fetcher.mock.calls) expect(new URL(String(call[0]), "https://sharpner.example").searchParams.get("items")!.split(",")).toHaveLength(16);
    responses[0]!(Response.json({ previews: [] }));
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(new URL(String(fetcher.mock.calls[4]![0]), "https://sharpner.example").searchParams.get("items")!.split(",")).toHaveLength(16);
  });

  it("never mixes files in a batch or substitutes original image uploads", async () => {
    const original = image();
    loader.prepare([url(1), url(2, "00000000-0000-4000-8000-000000000002")]);
    loader.load(original, "/a/file/u/original.jpg");
    loader.load(image(), url(1));
    loader.load(image(), url(2, "00000000-0000-4000-8000-000000000002"));
    await vi.advanceTimersByTimeAsync(10);
    expect(original.src).toBe("/a/file/u/original.jpg");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("loads the sharper working set in two stable batches while decoding only two images at a time", async () => {
    loader.dispose();
    loader = new PreviewLoader({ maxBatches: 1 });
    const images: Image[] = [];
    const cache = new ThumbnailCache(() => {}, {
      maxConcurrent: 2, maxEntries: 32, maxPixels: 32 * 1024 * 1024,
      loadImage: loader.load, prepareImages: loader.prepare,
      createImage: () => {
        const img = new Image(); images.push(img); return img as unknown as HTMLImageElement;
      },
    });
    const urls = Array.from({ length: 32 }, (_, i) => url(i).replace("-lo.webp", "-hi.webp"));
    cache.setViewport(urls.map((url) => ({ url, priority: 1 })));
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(10);
      expect(cache.stats.loading).toBeLessThanOrEqual(2);
      for (const img of images.filter((img) => img.src && img.onload)) img.onload?.();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(urls.every((url) => cache.get(url))).toBe(true);
    cache.dispose();
  });

  it("falls back to individual immutable images if a batch fails or omits an entry", async () => {
    const first = image(), second = image();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    loader.load(first, url(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(first.src).toBe(url(1));
    fetcher.mockResolvedValueOnce(Response.json({ previews: [] }));
    loader.load(second, url(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(second.src).toBe(url(2));
  });

  it("removes cancelled queued work and ignores a response arriving after disposal", async () => {
    const cancelled = image();
    loader.load(cancelled, url(1))();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetcher).not.toHaveBeenCalled();
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise((r) => { resolve = r; }));
    const late = image();
    loader.load(late, url(2));
    await vi.advanceTimersByTimeAsync(10);
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    loader.dispose();
    expect(signal.aborted).toBe(true);
    resolve(Response.json({ previews: [{ url: url(2), data: btoa("late") }] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(late.src).toBe("");
  });
});
