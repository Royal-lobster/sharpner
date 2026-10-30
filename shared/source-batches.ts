export type SourceItem = { id: string; rev: number; source: string };

/** Bound source responses by encoded bytes, not just node count. A single large node stays intact. */
export function* sourceBatches(items: Iterable<SourceItem>, maxBytes = 128 * 1024): Generator<SourceItem[]> {
  const encoder = new TextEncoder();
  const envelope = encoder.encode(JSON.stringify({ type: "source", items: [] })).byteLength;
  let batch: SourceItem[] = [], size = envelope;
  for (const item of items) {
    const bytes = encoder.encode(JSON.stringify(item)).byteLength;
    if (batch.length && size + bytes + 1 > maxBytes) {
      yield batch;
      batch = []; size = envelope;
    }
    size += bytes + (batch.length ? 1 : 0);
    batch.push(item);
    if (size >= maxBytes) { yield batch; batch = []; size = envelope; }
  }
  if (batch.length) yield batch;
}
