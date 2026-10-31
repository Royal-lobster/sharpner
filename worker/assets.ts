function imageResponse(object: R2ObjectBody) {
  return new Response(object.body, { headers: {
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
    etag: object.httpEtag,
  } });
}

/** Asset URLs contain immutable object revisions and random IDs; they are public capabilities. */
export async function serveAsset(
  request: Request,
  bucket: R2Bucket,
  cache: Pick<Cache, "match" | "put">,
  ctx: Pick<ExecutionContext, "waitUntil">,
) {
  const url = new URL(request.url);
  // Queries do not select a different R2 object. Keep one edge entry for each immutable path.
  const key = new Request(`${url.origin}${url.pathname}`);
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("server-timing", 'asset;desc="edge-hit"');
    return response;
  }
  const obj = await bucket.get(url.pathname.slice(3));
  if (!obj) return new Response("Not Found", { status: 404 });
  const response = imageResponse(obj);
  ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  response.headers.set("server-timing", 'asset;desc="edge-miss"');
  return response;
}

const FILE_ID = /^[a-f0-9-]{36}$/i;
const PREVIEW_NAME = /^[a-f0-9-]{36}-\d{1,12}-(?:lo|hi)\.webp$/i;
const MAX_BATCH_PREVIEWS = 16;
const MAX_CONCURRENT_PREVIEWS = 8;
const MAX_BATCH_BYTES = 1024 * 1024;
const BASE64_CHUNK_SIZE = 16_384;

/** All readers in a batch consume the same budget, including incomplete previews. */
async function readPreviewBase64(body: ReadableStream<Uint8Array>, budget: { remaining: number }) {
  const reader = body.getReader();
  const chunks: string[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return btoa(chunks.join(""));
      const data = part.value;
      if (data.byteLength > budget.remaining) {
        // A tee'd cache stream may wait for its other reader before resolving cancellation.
        void reader.cancel().catch(() => {});
        return undefined;
      }
      budget.remaining -= data.byteLength;
      for (let start = 0; start < data.length; start += BASE64_CHUNK_SIZE) {
        chunks.push(String.fromCharCode(...data.subarray(start, start + BASE64_CHUNK_SIZE)));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** An immutable bundle of existing thumbnail capabilities, with bounded R2 reads and response size. */
export async function servePreviewBatch(
  request: Request,
  fileId: string,
  bucket: R2Bucket,
  cache: Pick<Cache, "match" | "put">,
  ctx: Pick<ExecutionContext, "waitUntil">,
) {
  const url = new URL(request.url);
  const names = [...new Set((url.searchParams.get("items") ?? "").split(","))].sort();
  if (!FILE_ID.test(fileId) || names.length > MAX_BATCH_PREVIEWS || !names.every((name) => PREVIEW_NAME.test(name))) {
    return new Response("Invalid preview batch", { status: 400 });
  }
  url.search = "";
  url.searchParams.set("version", "1");
  url.searchParams.set("items", names.join(","));
  const key = new Request(url);
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("server-timing", 'asset;desc="edge-hit"');
    return response;
  }
  const previews: { url: string; data?: string }[] = [];
  const budget = { remaining: MAX_BATCH_BYTES };
  let next = 0;
  let objectHits = 0;
  let r2Reads = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PREVIEWS, names.length) }, async () => {
    while (next < names.length) {
      const index = next++;
      const name = names[index]!;
      const preview: { url: string; data?: string } = { url: `/a/${fileId}/t/${name}` };
      previews[index] = preview;
      try {
        const assetKey = new Request(new URL(preview.url, url.origin));
        let asset = await cache.match(assetKey).catch(() => undefined);
        if (asset?.status === 200) objectHits++;
        else {
          r2Reads++;
          const object = await bucket.get(`${fileId}/t/${name}`);
          if (!object) continue;
          if (object.size > budget.remaining) {
            void object.body.cancel().catch(() => {});
            continue;
          }
          asset = imageResponse(object);
          ctx.waitUntil(cache.put(assetKey, asset.clone()).catch(() => {}));
        }
        if (!asset.body) continue;
        preview.data = await readPreviewBase64(asset.body, budget);
      } catch { /* The browser can retry this one image through its normal immutable URL. */ }
    }
  }));
  const complete = previews.every((preview) => preview.data !== undefined);
  const response = Response.json({ version: 1, previews }, { headers: {
    "cache-control": complete ? "public, max-age=31536000, immutable" : "no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  } });
  if (complete) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  response.headers.set("server-timing", `asset;desc="edge-miss", objectCache;desc="${objectHits} hits", r2;desc="${r2Reads} reads"`);
  return response;
}
