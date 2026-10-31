type Group = { key: string; fileId: string; names: string[] };
type Pending = { image: HTMLImageElement; url: string; group: Group; cancelled: boolean; batch?: Batch };
type Batch = { controller: AbortController; items: Pending[]; timeout?: ReturnType<typeof setTimeout> };
const THUMBNAIL = /^\/a\/([a-f0-9-]{36})\/t\/([a-f0-9-]{36}-\d{1,12}-(?:lo|hi)\.webp)$/i;

/** Bounded transport for one admitted viewport preview set. Original images keep native loading. */
export class PreviewLoader {
  private groups = new Map<string, Group>();
  private ready = new Map<string, string>();
  private failed = new Set<string>();
  private pending: Pending[] = [];
  private batches = new Map<string, Batch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly maxBatches: number;

  constructor(options: { maxBatches?: number } = {}) {
    this.maxBatches = Math.max(1, Math.min(4, options.maxBatches ?? 4));
  }

  prepare = (urls: string[]) => {
    if (this.disposed) return;
    const previews = urls.filter((url) => THUMBNAIL.test(url));
    if (previews.length === this.groups.size && previews.every((url) => this.groups.has(url))) return;
    const files = new Map<string, { url: string; name: string }[]>();
    for (const url of previews.sort()) {
      const match = THUMBNAIL.exec(url)!;
      const entries = files.get(match[1]!) ?? [];
      entries.push({ url, name: match[2]! });
      files.set(match[1]!, entries);
    }
    const groups = new Map<string, Group>();
    for (const [fileId, entries] of files) for (let start = 0; start < entries.length; start += 16) {
      const chunk = entries.slice(start, start + 16), names = chunk.map((entry) => entry.name);
      const group = { key: `/a/${fileId}/bundle?version=1&items=${encodeURIComponent(names.join(","))}`, fileId, names };
      for (const entry of chunk) groups.set(entry.url, group);
    }
    this.groups = groups;
    for (const url of this.ready.keys()) if (!groups.has(url)) this.ready.delete(url);
    const keys = new Set([...groups.values()].map((group) => group.key));
    for (const key of this.failed) if (!keys.has(key)) this.failed.delete(key);
  };

  load = (image: HTMLImageElement, url: string): (() => void) => {
    const match = THUMBNAIL.exec(url);
    if (!match || this.disposed) {
      if (!this.disposed) image.src = url;
      return () => image.removeAttribute("src");
    }
    const group = this.groups.get(url) ?? { key: `/a/${match[1]}/bundle?version=1&items=${match[2]}`, fileId: match[1]!, names: [match[2]!] };
    // Preserve the immutable source while the image itself decodes from the batch response.
    image.dataset.previewSrc = url;
    const encoded = this.ready.get(url);
    if (encoded || this.failed.has(group.key)) {
      image.src = encoded ? `data:image/webp;base64,${encoded}` : url;
      return () => image.removeAttribute("src");
    }
    const item: Pending = { image, url, group, cancelled: false };
    const batch = this.batches.get(group.key);
    if (batch) { item.batch = batch; batch.items.push(item); }
    else { this.pending.push(item); this.schedule(); }
    return () => {
      item.cancelled = true;
      this.pending = this.pending.filter((candidate) => candidate !== item);
      image.removeAttribute("src");
      if (item.batch?.items.every((entry) => entry.cancelled)) item.batch.controller.abort();
    };
  };

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.groups.clear(); this.ready.clear(); this.failed.clear();
    for (const batch of this.batches.values()) { clearTimeout(batch.timeout); batch.controller.abort(); }
    this.batches.clear();
  }

  private schedule() {
    if (this.disposed || this.timer !== null || this.batches.size >= this.maxBatches || !this.pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 0);
  }

  private flush() {
    this.pending = this.pending.filter((item) => !item.cancelled);
    while (!this.disposed && this.batches.size < this.maxBatches && this.pending.length) {
      const group = this.pending[0]!.group, items: Pending[] = [];
      this.pending = this.pending.filter((item) => {
        if (item.group.key !== group.key) return true;
        items.push(item); return false;
      });
      const batch: Batch = { controller: new AbortController(), items };
      for (const item of items) item.batch = batch;
      this.batches.set(group.key, batch);
      batch.timeout = setTimeout(() => batch.controller.abort(), 15_000);
      void fetch(group.key, { signal: batch.controller.signal, credentials: "omit" }).then(async (response) => {
        if (!response.ok) throw new Error("Preview batch unavailable");
        const data = await response.json() as { previews: { url: string; data?: string }[] };
        const previews = new Map(data.previews.map((preview) => [preview.url, preview.data]));
        for (const name of group.names) {
          const url = `/a/${group.fileId}/t/${name}`, encoded = previews.get(url);
          if (this.groups.has(url) && encoded) this.ready.set(url, encoded);
          if (!encoded) this.failed.add(group.key);
        }
        for (const item of items) if (!this.disposed && !item.cancelled) {
          const encoded = previews.get(item.url);
          item.image.src = encoded ? `data:image/webp;base64,${encoded}` : item.url;
        }
      }).catch(() => {
        if (!batch.controller.signal.aborted) this.failed.add(group.key);
        for (const item of items) if (!this.disposed && !item.cancelled) item.image.src = item.url;
      }).finally(() => {
        clearTimeout(batch.timeout);
        for (const item of items) item.batch = undefined;
        this.batches.delete(group.key);
        this.schedule();
      });
    }
  }
}
