import { describe, expect, it } from "vitest";
import { sourceBatches, type SourceItem } from "./source-batches";
const bytes = (items: SourceItem[]) => new TextEncoder().encode(JSON.stringify({ type: "source", items })).byteLength;

describe("source response byte budget", () => {
  it("streams many large sources in ordered byte-bounded responses", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), rev: i, source: "x".repeat(300) }));
    const batches = [...sourceBatches(items, 1024)];
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items);
    expect(batches.every((batch) => bytes(batch) <= 1024)).toBe(true);
  });
  it("counts UTF-8 and JSON escaping rather than string length", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), rev: 1, source: '"界😀\\'.repeat(20) }));
    const batches = [...sourceBatches(items, 512)];
    expect(batches.every((batch) => bytes(batch) <= 512)).toBe(true);
    expect(batches.flat()).toEqual(items);
  });
  it("sends one oversized node intact without combining it with the next source", () => {
    const large = { id: "large", rev: 3, source: "x".repeat(2048) };
    const next = { id: "next", rev: 1, source: "small" };
    expect([...sourceBatches([large, next], 512)]).toEqual([[large], [next]]);
  });
  it("does not eagerly consume the entire source collection or emit empty messages", () => {
    let reads = 0;
    function* items() { for (let i = 0; i < 100; i++) { reads++; yield { id: String(i), rev: 1, source: "x".repeat(400) }; } }
    const batches = sourceBatches(items(), 1024);
    expect(batches.next().value?.length).toBe(2);
    expect(reads).toBeLessThan(5);
    expect([...sourceBatches([])]).toEqual([]);
  });
});
