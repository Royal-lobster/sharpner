import { describe, expect, it, vi } from "vitest";
import { serveAsset, servePreviewBatch } from "./assets";

function fixture() {
  const stored = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => stored.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => { stored.set(key.url, response); }),
  };
  const get = vi.fn(async () => ({ body: new Blob(["preview"]).stream(), httpMetadata: { contentType: "image/webp" }, httpEtag: '"revision"' }));
  const jobs: Promise<unknown>[] = [];
  const ctx = { waitUntil: (job: Promise<unknown>) => { jobs.push(job); } };
  return { cache, get, bucket: { get } as unknown as R2Bucket, ctx, jobs };
}

describe("immutable asset edge caching", () => {
  it("serves subsequent cold browser requests from the edge without another R2 read", async () => {
    const { cache, get, bucket, ctx, jobs } = fixture();
    const first = await serveAsset(new Request("https://sharpner.example/a/file/t/node-1-lo.webp?first"), bucket, cache, ctx);
    expect(await first.text()).toBe("preview");
    expect(first.headers.get("server-timing")).toContain("edge-miss");
    await Promise.all(jobs);
    const next = await serveAsset(new Request("https://sharpner.example/a/file/t/node-1-lo.webp?second"), bucket, cache, ctx);
    expect(await next.text()).toBe("preview");
    expect(next.headers.get("server-timing")).toContain("edge-hit");
    expect(next.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(next.headers.get("content-security-policy")).toContain("sandbox");
    expect(next.headers.get("etag")).toBe('"revision"');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("file/t/node-1-lo.webp");
  });

  it("does not cache a missing thumbnail, so a newly generated preview can appear", async () => {
    const { cache, bucket, get, ctx } = fixture();
    get.mockResolvedValueOnce(null as never);
    const result = await serveAsset(new Request("https://sharpner.example/a/missing.webp"), bucket, cache, ctx);
    expect(result.status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("falls back to R2 when the edge cache is unavailable", async () => {
    const { cache, bucket, ctx } = fixture();
    cache.match.mockRejectedValueOnce(new Error("cache unavailable"));
    const result = await serveAsset(new Request("https://sharpner.example/a/node.webp"), bucket, cache, ctx);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("preview");
  });
});

const file = "4d0f3398-96fd-4b9c-a8fc-dd7b1b75f437";
const name = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}-1-lo.webp`;
const batchRequest = (names: string[]) => new Request(`https://sharpner.example/a/${file}/bundle?items=${encodeURIComponent(names.join(","))}`);

describe("bounded immutable preview batches", () => {
  it("reuses an individually cached image when assembling a new batch without reading R2", async () => {
    const { cache, ctx, bucket, get } = fixture();
    const url = `/a/${file}/t/${name(1)}`;
    await cache.put(new Request("https://sharpner.example" + url), new Response("preview"));
    const response = await servePreviewBatch(batchRequest([name(1)]), file, bucket, cache, ctx);
    expect(await response.json()).toEqual({ version: 1, previews: [{ url, data: btoa("preview") }] });
    expect(response.headers.get("server-timing")).toContain("1 hits");
    expect(response.headers.get("server-timing")).toContain("0 reads");
    expect(get).not.toHaveBeenCalled();
  });

  it("enforces the total byte budget even for cached responses without size metadata", async () => {
    const { cache, ctx, bucket, get } = fixture();
    const url = `/a/${file}/t/${name(1)}`;
    await cache.put(new Request("https://sharpner.example" + url), new Response(new Uint8Array(1024 * 1024 + 1)));
    const response = await servePreviewBatch(batchRequest([name(1)]), file, bucket, cache, ctx);
    expect(await response.json()).toEqual({ version: 1, previews: [{ url }] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the requested previews and reuses a canonical edge entry regardless of order", async () => {
    const { cache, ctx, jobs } = fixture();
    const get = vi.fn(async () => ({ size: 7, body: new Blob(["preview"]).stream(), httpEtag: '"preview"' }));
    const bucket = { get } as unknown as R2Bucket;
    const first = await servePreviewBatch(batchRequest([name(2), name(1)]), file, bucket, cache, ctx);
    expect(await first.json()).toEqual({ version: 1, previews: [1, 2].map((i) => ({ url: `/a/${file}/t/${name(i)}`, data: btoa("preview") })) });
    expect(first.headers.get("cache-control")).toContain("immutable");
    await Promise.all(jobs);
    const next = await servePreviewBatch(batchRequest([name(1), name(2), name(1)]), file, bucket, cache, ctx);
    expect(next.headers.get("server-timing")).toContain("edge-hit");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reads at most eight R2 objects at once, even for a full batch", async () => {
    const { cache, ctx } = fixture();
    let active = 0, peak = 0;
    const get = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { size: 7, body: new Blob(["preview"]).stream(), httpEtag: '"preview"' };
    });
    const response = await servePreviewBatch(batchRequest(Array.from({ length: 16 }, (_, i) => name(i))), file, { get } as unknown as R2Bucket, cache, ctx);
    expect(response.status).toBe(200);
    expect(peak).toBe(8);
    expect(get).toHaveBeenCalledTimes(16);
  });

  it.each([[name(1), "../../private"], Array.from({ length: 17 }, (_, i) => name(i)), []].map((names) => ({ names })))("rejects unbounded or non-thumbnail inputs: %j", async ({ names }) => {
    const { cache, ctx, bucket, get } = fixture();
    expect((await servePreviewBatch(batchRequest(names), file, bucket, cache, ctx)).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("leaves missing or over-budget previews to native loading and never caches a partial result", async () => {
    const { cache, ctx } = fixture();
    const cancel = vi.fn(async () => {});
    const read = vi.fn(async () => new ArrayBuffer(2 * 1024 * 1024));
    const get = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ size: 2 * 1024 * 1024, body: { cancel }, arrayBuffer: read });
    const response = await servePreviewBatch(batchRequest([name(1), name(2)]), file, { get } as unknown as R2Bucket, cache, ctx);
    expect(await response.json()).toEqual({ version: 1, previews: [1, 2].map((i) => ({ url: `/a/${file}/t/${name(i)}` })) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.put).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});
