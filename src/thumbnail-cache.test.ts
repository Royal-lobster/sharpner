import { describe, expect, it, vi } from "vitest";
import { ThumbnailCache, thumbnailSource, type ThumbnailRequest } from "./thumbnail-cache";

const PIXELS = 256 * 256;
function fixture(options: ConstructorParameters<typeof ThumbnailCache>[1] = {}) {
  let time = 0, maxActive = 0;
  const started: string[] = [], instances: FakeImage[] = [], active = new Set<FakeImage>();
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0; naturalHeight = 0; complete = false;
    decoding = ""; fetchPriority = ""; value = "";
    constructor() { instances.push(this); }
    set src(url: string) {
      this.value = url; this.complete = false;
      if (url) { started.push(url); active.add(this); maxActive = Math.max(maxActive, active.size); }
    }
    get src() { return this.value; }
    removeAttribute() { this.value = ""; active.delete(this); }
    finish(width = 256, height = 256) {
      active.delete(this); this.complete = true; this.naturalWidth = width; this.naturalHeight = height; this.onload?.();
    }
    fail() { active.delete(this); this.onerror?.(); }
  }
  const changed = vi.fn();
  const cache = new ThumbnailCache(changed, { createImage: () => new FakeImage() as unknown as HTMLImageElement, now: () => time, ...options });
  const drain = (width = 256, height = 256) => {
    for (let iterations = 0; active.size && iterations < 5000; iterations++) [...active][0]!.finish(width, height);
    expect(active.size).toBe(0);
  };
  return { cache, started, instances, active, changed, drain, advance: (ms: number) => { time += ms; }, maxActive: () => maxActive };
}
const request = (url: string, priority = 0, pixels = PIXELS): ThumbnailRequest => ({ url, priority, pixels });

describe("viewport thumbnail cache", () => {
  it("settles a stable 800-URL viewport without repeated Image allocations or downloads", () => {
    const f = fixture();
    const requests = Array.from({ length: 800 }, (_, i) => request(`/preview-${i}.webp`));
    f.cache.setViewport(requests);
    expect(f.started).toHaveLength(16);
    f.drain();
    const first = f.started.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(600);
    for (let paint = 0; paint < 100; paint++) {
      f.cache.setViewport(requests);
      const ready = requests.filter(({ url }) => f.cache.get(url));
      expect(ready).toHaveLength(first);
    }
    expect(f.started).toHaveLength(first);
    expect(f.instances).toHaveLength(first);
    expect(f.maxActive()).toBeLessThanOrEqual(16);
    expect(f.cache.stats.decodedPixels).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("keeps the entry cap stable for 700 thin images even when the pixel budget has spare room", () => {
    const f = fixture();
    const requests = Array.from({ length: 700 }, (_, i) => request(`/strip-${i}.webp`, 0, 400 * 20));
    f.cache.setViewport(requests); f.drain(400, 20);
    expect(f.instances).toHaveLength(600);
    for (let paint = 0; paint < 50; paint++) f.cache.setViewport(requests);
    expect(f.instances).toHaveLength(600);
    expect(f.cache.stats.admitted).toBe(600);
    expect(f.cache.has('/strip-699.webp')).toBe(false);
  });

  it("admits the highest-priority viewport images before overscan work", () => {
    const f = fixture({ maxEntries: 2, maxPixels: PIXELS * 2 });
    f.cache.setViewport([request('overscan', 0), request('visible-small', 100), request('visible-large', 200)]);
    expect(f.started).toEqual(['visible-large', 'visible-small']);
    expect(f.cache.has('overscan')).toBe(false);
  });

  it("cancels offscreen queued/inflight work and ignores callbacks that raced cancellation", () => {
    const f = fixture({ maxEntries: 4, maxConcurrent: 2 });
    f.cache.setViewport(['old-a', 'old-b', 'old-c', 'old-d'].map((url) => request(url)));
    const raced = f.instances[0]!.onload!;
    f.cache.setViewport([request('new-a'), request('new-b')]);
    expect(f.instances[0]!.src).toBe('');
    expect(f.instances[1]!.src).toBe('');
    expect(f.started).toEqual(['old-a', 'old-b', 'new-a', 'new-b']);
    raced();
    expect(f.cache.stats.loading).toBe(2);
    expect(f.changed).not.toHaveBeenCalled();
    f.drain();
    expect(f.cache.get('new-a')).not.toBeNull();
    expect(f.cache.get('old-a')).toBeNull();
    expect(f.maxActive()).toBeLessThanOrEqual(2);
  });

  it("replans against actual decoded dimensions without repeatedly loading evicted candidates", () => {
    const f = fixture({ maxEntries: 10, maxPixels: PIXELS * 4, maxConcurrent: 2 });
    const requests = ['a', 'b', 'c', 'd'].map((url) => request(url));
    f.cache.setViewport(requests);
    f.instances[0]!.finish(512, 512);
    expect(f.cache.stats.decodedPixels).toBe(PIXELS * 4);
    expect(f.cache.stats.loading).toBe(0);
    expect(f.cache.stats.entries).toBe(1);
    for (let i = 0; i < 10; i++) f.cache.setViewport(requests);
    expect(f.started).toEqual(['a', 'b']);
    expect(f.cache.get('a')).not.toBeNull();
  });

  it("rejects an oversized image once and releases its decoded buffer", () => {
    const f = fixture({ maxPixels: PIXELS * 2 });
    const requests = [request('oversized')];
    f.cache.setViewport(requests); f.instances[0]!.finish(4096, 4096);
    for (let i = 0; i < 100; i++) f.cache.setViewport(requests);
    expect(f.started).toEqual(['oversized']);
    expect(f.instances[0]!.src).toBe('');
    expect(f.cache.stats.decodedPixels).toBe(0);
    expect(f.cache.has('oversized')).toBe(false);
  });

  it("retains spare decoded previews for a return pan and evicts least-recently-used entries only when needed", () => {
    const f = fixture({ maxEntries: 2, maxPixels: PIXELS * 2 });
    f.cache.setViewport([request('a')]); f.drain(); f.cache.get('a');
    f.cache.setViewport([request('b')]); f.drain();
    f.cache.setViewport([request('a')]);
    expect(f.cache.get('a')).not.toBeNull();
    expect(f.started).toEqual(['a', 'b']);
    f.cache.setViewport([request('c')]); f.drain();
    f.cache.setViewport([request('a')]);
    expect(f.cache.get('a')).not.toBeNull();
    expect(f.started).toEqual(['a', 'b', 'c']);
  });

  it("does not spin on failing URLs, including when panning away and back, and permits a later retry", () => {
    const f = fixture();
    f.cache.setViewport([request('missing')]); f.instances[0]!.fail();
    for (let i = 0; i < 100; i++) f.cache.setViewport([request('missing')]);
    f.cache.setViewport([]); f.cache.setViewport([request('missing')]);
    expect(f.started).toEqual(['missing']);
    f.advance(30_001); f.cache.setViewport([request('missing')]); f.drain();
    expect(f.started).toEqual(['missing', 'missing']);
    expect(f.cache.get('missing')).not.toBeNull();
  });

  it("disposes per-canvas work and cannot notify a discarded StrictMode lifecycle", () => {
    const first = fixture(); first.cache.setViewport([request('a'), request('b')]);
    const raced = first.instances[0]!.onload!;
    first.cache.dispose(); raced();
    expect(first.active.size).toBe(0);
    expect(first.cache.stats.entries).toBe(0);
    expect(first.cache.stats.loading).toBe(0);
    expect(first.changed).not.toHaveBeenCalled();
    first.cache.setViewport([request('c')]);
    expect(first.started).toEqual(['a', 'b']);
    const second = fixture(); second.cache.setViewport([request('a')]); second.drain();
    expect(second.cache.get('a')).not.toBeNull();
    expect(second.changed).toHaveBeenCalledTimes(1);
  });
});

describe("image resolution policy", () => {
  it("never substitutes the original upload for a missing low-resolution preview", () => {
    const image = { kind: 'image', src: '/original-4k.jpg', thumbHi: '/original-4k.jpg', thumbLo: null };
    expect(thumbnailSource(image)).toBeNull();
    expect(thumbnailSource(image, true)).toBe('/original-4k.jpg');
    expect(thumbnailSource({ ...image, thumbLo: image.src })).toBeNull();
    expect(thumbnailSource({ ...image, thumbLo: '/preview.webp' })).toBe('/preview.webp');
  });
});
