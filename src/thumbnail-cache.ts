export type ThumbnailRequest = { url: string; priority: number; pixels?: number };
type Status = "queued" | "loading" | "ready" | "error";
type Entry = { url: string; status: Status; image: HTMLImageElement | null; pixels: number; used: number; retryAt: number; cancel?: () => void };
type Knowledge = { pixels: number; retryAt: number };
type Options = {
  maxEntries?: number;
  maxPixels?: number;
  maxConcurrent?: number;
  createImage?: () => HTMLImageElement;
  now?: () => number;
  loadImage?: (image: HTMLImageElement, url: string) => () => void;
  prepareImages?: (urls: string[]) => void;
};
const DEFAULT_PIXELS = 256 * 256;
const RETRY_MS = 30_000;

/** Originals are a deliberate high-resolution promotion, never a low-resolution fallback. */
export function thumbnailSource(node: { kind: string; thumbLo: string | null; thumbHi: string | null; src?: string | null }, high = false) {
  if (node.kind === "image") return high ? node.thumbHi ?? node.src ?? node.thumbLo : node.thumbLo === node.src ? null : node.thumbLo;
  return high ? node.thumbHi ?? node.thumbLo : node.thumbLo ?? node.thumbHi;
}

/**
 * Admit a stable viewport working set before starting requests. Over-budget nodes stay at box LOD,
 * rather than evicting thumbnails the same paint still needs. Spare ready entries form a small LRU.
 */
export class ThumbnailCache {
  private readonly entries = new Map<string, Entry>();
  private readonly knowledge = new Map<string, Knowledge>();
  private readonly maxEntries: number;
  private readonly maxPixels: number;
  private readonly maxConcurrent: number;
  private readonly makeImage: () => HTMLImageElement;
  private readonly now: () => number;
  private readonly loadImage: NonNullable<Options["loadImage"]>;
  private readonly prepareImages: Options["prepareImages"];
  private requests: ThumbnailRequest[] = [];
  private desired = new Set<string>();
  private active = 0;
  private clock = 0;
  private disposed = false;
  private pumping = false;

  constructor(private changed: () => void, options: Options = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 600);
    this.maxPixels = Math.max(1, options.maxPixels ?? 16 * 1024 * 1024);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 16);
    this.makeImage = options.createImage ?? (() => new Image());
    this.now = options.now ?? Date.now;
    this.loadImage = options.loadImage ?? ((image, url) => { image.src = url; return () => image.removeAttribute("src"); });
    this.prepareImages = options.prepareImages;
  }

  setViewport(requests: ThumbnailRequest[]) {
    if (this.disposed) return;
    const unique = new Map<string, ThumbnailRequest>();
    for (const request of requests) {
      const existing = unique.get(request.url);
      if (request.url && (!existing || request.priority > existing.priority)) unique.set(request.url, request);
    }
    this.requests = [...unique.values()].sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url)).slice(0, this.maxEntries * 4);
    this.reconcile();
    this.prepareImages?.([...this.desired]);
    this.pump();
  }

  has(url: string) { return this.desired.has(url); }

  get(url: string): HTMLImageElement | null {
    if (!this.desired.has(url)) return null;
    const entry = this.entries.get(url);
    if (entry?.status !== "ready") return null;
    entry.used = ++this.clock;
    return entry.image;
  }

  get stats() {
    let decodedPixels = 0, queued = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "ready") decodedPixels += entry.pixels;
      if (entry.status === "queued") queued++;
    }
    return { entries: this.entries.size, admitted: this.desired.size, loading: this.active, queued, decodedPixels };
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear(); this.knowledge.clear(); this.desired.clear(); this.requests = [];
    this.changed = () => {};
  }

  private cost(request: ThumbnailRequest) {
    const pixels = this.knowledge.get(request.url)?.pixels ?? this.entries.get(request.url)?.pixels ?? request.pixels ?? DEFAULT_PIXELS;
    return Number.isFinite(pixels) && pixels > 0 ? Math.ceil(pixels) : DEFAULT_PIXELS;
  }

  private reconcile() {
    let pixels = 0;
    const admitted: ThumbnailRequest[] = [];
    for (const request of this.requests) {
      const cost = this.cost(request);
      if (admitted.length >= this.maxEntries || pixels + cost > this.maxPixels) continue;
      pixels += cost;
      admitted.push(request);
    }
    this.desired = new Set(admitted.map((request) => request.url));
    // Pending work no longer needed by this viewport must not occupy a download slot.
    for (const [url, entry] of this.entries) if (!this.desired.has(url) && entry.status !== "ready") {
      this.release(entry); this.entries.delete(url);
    }
    const spare = [...this.entries.values()].filter((entry) => !this.desired.has(entry.url)).sort((a, b) => b.used - a.used);
    let count = admitted.length;
    for (const entry of spare) {
      if (count < this.maxEntries && pixels + entry.pixels <= this.maxPixels) { count++; pixels += entry.pixels; }
      else { this.release(entry); this.entries.delete(entry.url); }
    }
    for (const request of admitted) {
      let entry = this.entries.get(request.url);
      const retryAt = this.knowledge.get(request.url)?.retryAt ?? 0;
      if (!entry) {
        entry = { url: request.url, status: retryAt > this.now() ? "error" : "queued", image: null, pixels: this.cost(request), used: ++this.clock, retryAt };
        this.entries.set(request.url, entry);
      } else if (entry.status === "error" && entry.retryAt <= this.now()) entry.status = "queued";
    }
    // Retain costs/errors for the current candidate set, so a rejected large image cannot restart
    // on every paint. Forget old metadata as the viewport moves; ready entries carry their own cost.
    const current = new Set(this.requests.map((request) => request.url));
    for (const url of this.knowledge.keys()) if (this.knowledge.size > this.maxEntries * 4 && !current.has(url)) this.knowledge.delete(url);
  }

  private pump() {
    if (this.disposed || this.pumping) return;
    this.pumping = true;
    try {
      for (const request of this.requests) {
        if (this.active >= this.maxConcurrent) break;
        const entry = this.entries.get(request.url);
        if (!this.desired.has(request.url) || entry?.status !== "queued") continue;
        entry.status = "loading";
        this.active++;
        try {
          const image = entry.image = this.makeImage();
          image.decoding = "async";
          image.fetchPriority = "low";
          image.onload = () => this.settle(entry, true);
          image.onerror = () => this.settle(entry, false);
          entry.cancel = this.loadImage(image, entry.url);
        } catch { this.settle(entry, false); }
      }
    } finally { this.pumping = false; }
  }

  private settle(entry: Entry, loaded: boolean) {
    if (this.disposed || this.entries.get(entry.url) !== entry || entry.status !== "loading") return;
    this.active--;
    const image = entry.image;
    const pixels = (image?.naturalWidth ?? 0) * (image?.naturalHeight ?? 0);
    if (loaded && Number.isFinite(pixels) && pixels > 0) {
      entry.status = "ready"; entry.pixels = pixels; entry.retryAt = 0;
      if (image) image.onload = image.onerror = null;
    } else {
      entry.status = "error"; entry.retryAt = this.now() + RETRY_MS;
      this.release(entry);
    }
    this.knowledge.delete(entry.url);
    this.knowledge.set(entry.url, { pixels: entry.pixels, retryAt: entry.retryAt });
    this.reconcile();
    this.pump();
    this.changed();
  }

  private release(entry: Entry) {
    if (entry.status === "loading") this.active--;
    if (entry.image) {
      entry.image.onload = entry.image.onerror = null;
      entry.cancel?.();
      entry.cancel = undefined;
      entry.image.removeAttribute("src");
      entry.image = null;
    }
  }
}
