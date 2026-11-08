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

describe("single-capture thumbnail tiers", () => {
  it("captures once and derives the overview raster at the captured aspect ratio", async () => {
    const { captureThumbnails } = await import("./render");
    const drawImage = vi.fn();
    const canvas = {width:0,height:0,getContext:()=>({drawImage,imageSmoothingQuality:""}),toDataURL:()=>"data:image/webp;base64,AQID"};
    vi.stubGlobal("document",{createElement:()=>canvas});
    vi.stubGlobal("Image",class {
      naturalWidth=1280;naturalHeight=5120;onload: (()=>void)|null=null;
      set src(_value:string) {queueMicrotask(()=>this.onload?.());}
    });
    const page = {screenshot:vi.fn(async()=>new Uint8Array([4,5,6])),evaluate:async(fn: (arg:unknown)=>unknown,arg:unknown)=>fn(arg)};
    const result = await captureThumbnails(page as unknown as Page,2000,8000);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(canvas).toMatchObject({width:256,height:1024});
    expect(result).toEqual({hi:new Uint8Array([4,5,6]),lo:new Uint8Array([1,2,3])});
  });
  it("reuses one raster for both tiers when the frame is already small", async()=>{
    const { captureThumbnails } = await import("./render");
    const page={screenshot:vi.fn(async()=>new Uint8Array([4])),evaluate:vi.fn()};
    const result=await captureThumbnails(page as unknown as Page,200,600);
    expect(result.lo).toBe(result.hi);expect(page.screenshot).toHaveBeenCalledTimes(1);expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("auto-height frame viewport", () => {
  /**
   * A tab whose body height depends on the viewport the way a laid-out page does: `content` is the flow height,
   * `minScreen` adds min-height:100vh, and `grows` adds a 100vh block above that content. A fixed bottom bar adds
   * nothing to the body; it sits `bar` px above the bottom of the viewport.
   */
  function layoutTab(page: { content: number; minScreen?: boolean; grows?: boolean }) {
    let viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
    const body = () => page.grows ? viewport.height + page.content : page.minScreen ? Math.max(page.content, viewport.height) : page.content;
    let evaluations = 0;
    const tab = {
      goto: vi.fn(async () => {}),
      viewport: () => viewport,
      setViewport: vi.fn(async (next: { width: number; height: number }) => { viewport = { ...next, deviceScaleFactor: 1 }; }),
      setContent: vi.fn(async () => {}),
      // The first evaluation reads the document's classes for the Tailwind pass; every later one measures the body.
      evaluate: vi.fn(async () => evaluations++ === 0 ? { css: "", classes: [] } : body()),
    };
    return { tab: tab as unknown as Page, calls: tab, viewport: () => viewport };
  }
  const design = { tokens: "", components: [] };

  it("sends a document only the components it uses, and those components' own, as a live iframe gets", async () => {
    const { loadFrame, documentDesign } = await import("./render");
    const system = { tokens: "", fonts: "@font-face{}", components: [
      { tag: "x-card", html: "<div><x-badge></x-badge></div>" },
      { tag: "x-badge", html: "<span>New</span>" },
      { tag: "x-screen-huge", html: "<main>" + "unused ".repeat(1000) + "</main>" },
    ] };
    expect(documentDesign("<x-card></x-card>", system)).toEqual({ tokens: "", fonts: "@font-face{}", components: system.components.slice(0, 2) });
    // Tags built at runtime can't be followed, so such a document keeps the whole design.
    expect(documentDesign("<script>document.createElement(`x-${kind}`)</script>", system)).toBe(system);
    const { tab, calls } = layoutTab({ content: 100 });
    await loadFrame(tab, { html: "<x-card></x-card>", width: 390, height: null }, "https://sharpner.test", system);
    const doc = (calls.setContent.mock.calls[0] as unknown as [string])[0];
    expect(doc).toContain('"x-badge"');
    expect(doc).not.toContain("x-screen-huge");
  });

  it("gives a document with authored scripts time to draw before reading, measuring and capturing it", async () => {
    const { loadFrame, SCRIPT_SETTLE_MS } = await import("./render");
    const settleOf = async (html: string, system: { tokens: string; components: { tag: string; html: string }[] }) => {
      const { tab, calls } = layoutTab({ content: 100 });
      await loadFrame(tab, { html, width: 390, height: null }, "https://sharpner.test", system);
      // The first evaluation, which reads the document's classes before any measurement, waits this long.
      return (calls.evaluate.mock.calls[0] as unknown as [unknown, number])[1];
    };
    expect(await settleOf("<main></main>", design)).toBe(0);
    expect(await settleOf("<main></main><script>requestAnimationFrame(draw)</script>", design)).toBe(SCRIPT_SETTLE_MS);
    // A script in a component the document embeds counts; one in a component it never uses does not.
    const system = { tokens: "", components: [{ tag: "x-chart", html: "<div></div><SCRIPT>draw()</SCRIPT>" }] };
    expect(await settleOf("<x-chart></x-chart>", system)).toBe(SCRIPT_SETTLE_MS);
    expect(await settleOf("<main></main>", system)).toBe(0);
  });

  it("lays an auto-height frame out in a viewport as tall as its content, as the live canvas iframe is", async () => {
    const { loadFrame } = await import("./render");
    const { tab, calls, viewport } = layoutTab({ content: 2337 });
    const size = await loadFrame(tab, { html: "<main></main>", width: 390, height: null }, "https://sharpner.test", design);
    expect(size).toEqual({ width: 390, measured: 2337, height: 2337 });
    // A bar fixed 84px above the bottom therefore lands at the end of the page, not 84px above y=800.
    expect(viewport()).toMatchObject({ width: 390, height: 2337 });
    expect(calls.setViewport.mock.calls.map(([v]) => v)).toEqual([{ width: 390, height: 800 }, { width: 390, height: 2337 }]);
  });

  it("fits short frames too, and settles at once when 100vh content already fills the first viewport", async () => {
    const { loadFrame } = await import("./render");
    const short = layoutTab({ content: 300 });
    expect(await loadFrame(short.tab, { html: "<p></p>", width: 390, height: null }, "https://sharpner.test", design)).toMatchObject({ height: 300 });
    expect(short.viewport().height).toBe(300);
    const screen = layoutTab({ content: 500, minScreen: true });
    expect(await loadFrame(screen.tab, { html: "<p></p>", width: 390, height: null }, "https://sharpner.test", design)).toMatchObject({ height: 800 });
    expect(screen.calls.setViewport).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed-height frame's viewport, and the first layout for content that never settles", async () => {
    const { loadFrame } = await import("./render");
    const fixed = layoutTab({ content: 2000 });
    expect(await loadFrame(fixed.tab, { html: "<p></p>", width: 390, height: 844 }, "https://sharpner.test", design)).toMatchObject({ height: 844 });
    expect(fixed.calls.setViewport.mock.calls.map(([v]) => v)).toEqual([{ width: 390, height: 844 }]);
    // A viewport-high section above 200px of content grows with every fitting pass, so the 800px layout stays.
    const growing = layoutTab({ content: 200, grows: true });
    const size = await loadFrame(growing.tab, { html: "<p></p>", width: 390, height: null }, "https://sharpner.test", design);
    expect(growing.calls.setViewport.mock.calls.map(([v]) => v.height)).toEqual([800, 1000, 1200, 1400, 800]);
    expect(size).toMatchObject({ measured: 1000, height: 1000 });
    // Taller than the capture limit: the viewport stops at 8000px and the content no longer changes with it.
    const long = layoutTab({ content: 9000 });
    expect(await loadFrame(long.tab, { html: "<p></p>", width: 390, height: null }, "https://sharpner.test", design)).toMatchObject({ measured: 9000, height: 8000 });
    expect(long.viewport().height).toBe(8000);
  });
});
