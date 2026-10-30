import type { Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capture, loadImagePreview, withTimeout } from "./render";

afterEach(() => vi.unstubAllGlobals());

function backgroundPage(width: number, height: number, fail = false) {
  let attached = false;
  const image = {
    naturalWidth: width, naturalHeight: height, style: { cssText: "" },
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    // Background tabs may never receive the rendering update that resolves decode().
    decode: vi.fn(() => new Promise<void>(() => {})),
    set src(_url: string) {
      expect(attached).toBe(true);
      queueMicrotask(() => fail ? this.onerror?.() : this.onload?.());
    },
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => { expect(tag).toBe("img"); return image; },
    body: { style: { cssText: "" }, appendChild: (node: unknown) => { expect(node).toBe(image); attached = true; } },
  });
  vi.stubGlobal("Image", class { constructor() { return image; } });
  const page = {
    goto: vi.fn(async () => {}),
    evaluate: async (fn: (url: string) => Promise<unknown>, url: string) => fn(url),
    setViewport: vi.fn(async () => {}),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  return { page: page as unknown as Page, calls: page, image };
}

describe("background image preview rendering", () => {
  it("finishes from load without waiting for an unavailable background decode frame", async () => {
    const { page, calls, image } = backgroundPage(3840, 2160);
    await expect(withTimeout(loadImagePreview(page, "/a/photo.jpg", "https://sharpner.example"), 100, "background image"))
      .resolves.toEqual({ width: 400, height: 225 });
    expect(image.decode).not.toHaveBeenCalled();
    expect(calls.goto).toHaveBeenCalledWith("about:blank");
    expect(calls.setViewport).toHaveBeenCalledWith({ width: 400, height: 225 });
  });

  it.each([
    { width: 100, height: 10_000, expected: { width: 16, height: 1600 } },
    { width: 120, height: 60, expected: { width: 120, height: 60 } },
  ])("bounds tall previews without upscaling small sources: $width × $height", async ({ width, height, expected }) => {
    await expect(loadImagePreview(backgroundPage(width, height).page, "/a/photo.png", "https://sharpner.example")).resolves.toEqual(expected);
  });

  it("rejects failed image loads instead of leaving a tab occupied indefinitely", async () => {
    const { page } = backgroundPage(0, 0, true);
    await expect(loadImagePreview(page, "/a/missing.jpg", "https://sharpner.example")).rejects.toThrow("Image could not be loaded");
  });

  it("preserves transparency for generated WebP previews", async () => {
    const { page, calls } = backgroundPage(200, 200);
    await capture(page, 200, 200, { type: "webp", scale: 1, transparent: true });
    expect(calls.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "webp", omitBackground: true }));
  });
});
