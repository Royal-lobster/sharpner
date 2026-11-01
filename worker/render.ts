import type { Page as BrowserPage } from "@cloudflare/puppeteer";
import { thumbnailCss } from "./thumbnail-css";
import { frameDocument, type DesignSystem } from "../shared/types";

const MAX_HEIGHT = 8000;

/** Chunked encoding avoids argument/stack limits for large captures. */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Like @tailwindcss/browser, a stylesheet that fails to compile contributes no CSS instead of failing the capture. */
const tailwindCss = (input: string, candidates: string[]) => thumbnailCss(input, candidates).catch((err) => {
  console.warn("tailwind compile failed", String(err));
  return "";
});

/**
 * Loads HTML into a browser tab at its viewport width and waits for fonts and Tailwind.
 * Returns the height to capture (fixed height, or measured content height for auto frames).
 */
export async function loadFrame(page: BrowserPage, f: { html: string; width: number; height: number | null; theme?: string | null }, base: string, design: DesignSystem) {
  const width = Math.max(1, Math.round(f.width));
  // Seed styles before navigation, so fonts and CSS images load alongside document resources.
  // The DOM pass below covers classes/styles produced by props, slots and authored scripts.
  const initial = frameDocument(f.html, { base, design, theme: f.theme, compiledTailwind: true });
  const cssSource = [...initial.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n");
  const sources = [f.html, ...design.components.map((c) => c.html)].join("\n");
  const candidates = [...sources.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap((match) => (match[1] ?? match[2] ?? match[3]!).split(/\s+/));
  const seedCss = await tailwindCss(cssSource, candidates);
  // Fresh windows prevent custom element definitions and authored scripts leaking between nodes.
  await page.goto("about:blank");
  const viewportHeight = Math.round(f.height ?? 800), viewport = page.viewport();
  if (viewport?.width !== width || viewport.height !== viewportHeight || (viewport.deviceScaleFactor ?? 1) !== 1) {
    await page.setViewport({ width, height: viewportHeight });
  }
  await page.setContent(frameDocument(f.html, { base, design, theme: f.theme, compiledTailwind: true, tailwindCss: seedCss }), { waitUntil: "load", timeout: 20_000 });
  // Component expansion and the theme script have finished parsing. Read actual classes rather
  // than guessing from source (props, slots, SVG and theme overrides may create new classes).
  const { css, classes } = await page.evaluate(() => ({
    css: [...document.querySelectorAll('style[type="text/tailwindcss"]')].map((style) => style.textContent).join("\n"),
    classes: [...new Set([...document.querySelectorAll("[class]")].flatMap((el) => [...el.classList]))],
  }));
  const compiled = await tailwindCss(css, classes);
  const measured = await page.evaluate(async ({ css, changed }) => {
    if (!changed) {
      document.body.getBoundingClientRect();
      await document.fonts.ready;
      return Math.ceil(document.body.getBoundingClientRect().height);
    }
    document.querySelector("style[data-sharpner-css]")!.textContent = css;
    // Flush layout to start font and CSS image loads. No animation frame or arbitrary delay:
    // background tabs need not receive frames, and compilation is already complete.
    document.body.getBoundingClientRect();
    const elements = [document.body, ...document.body.querySelectorAll("*")];
    const urls = new Set<string>();
    for (const element of elements) {
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        for (const value of [style.backgroundImage, style.maskImage, style.listStyleImage]) {
          for (const match of value.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]!);
        }
      }
    }
    await Promise.all([document.fonts.ready, ...[...urls].map((url) => new Promise<void>((resolve) => {
      const image = new Image(); image.onload = image.onerror = () => resolve(); image.src = url;
    }))]);
    return Math.ceil(document.body.getBoundingClientRect().height);
  }, { css: compiled, changed: compiled !== seedCss });
  return { width, measured, height: Math.min(MAX_HEIGHT, Math.max(1, Math.round(f.height ?? measured))) };
}

export async function capture(page: BrowserPage, width: number, height: number, opts: { type: "jpeg" | "webp"; scale: number; quality?: number; transparent?: boolean }) {
  return (await page.screenshot({
    type: opts.type,
    quality: opts.quality ?? 80,
    clip: { x: 0, y: 0, width, height, scale: opts.scale },
    captureBeyondViewport: true,
    omitBackground: opts.transparent ?? false,
  })) as Uint8Array;
}

/** Raster images need a small preview too; no fonts, Tailwind, or component runtime is required. */
export async function loadImagePreview(page: BrowserPage, src: string, base: string) {
  await page.goto("about:blank");
  const size = await page.evaluate(async (url) => {
    const image = document.createElement("img");
    // decode() can wait for a rendering update indefinitely in a background browser tab.
    // A load event does not need foreground animation; screenshot() later forces the paint.
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image could not be loaded"));
    });
    document.body.style.cssText = "margin:0;background:transparent";
    image.style.cssText = "display:block;max-width:400px;max-height:1600px";
    document.body.appendChild(image);
    image.src = url;
    await loaded;
    image.onload = image.onerror = null;
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image has no dimensions");
    const scale = Math.min(1, 400 / image.naturalWidth, 1600 / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    image.style.cssText = `display:block;width:${width}px;height:${height}px`;
    return { width, height };
  }, new URL(src, base).href);
  await page.setViewport(size);
  return size;
}

/** Rejects if `p` doesn't settle in time, so one stuck page can't wedge a render batch. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms))),
  ]);
}

/** Capture layout once; derive overview pixels from the hi raster without a second browser screenshot. */
export async function captureThumbnails(page: BrowserPage, width: number, height: number) {
  const hi = await capture(page, width, height, { type: "webp", scale: Math.min(1, 1280 / width) });
  if (width <= 256) return { lo: hi, hi };
  // Chunk encoding avoids argument/stack limits for tall captures.
  const encoded = bytesToBase64(hi);
  const small = await page.evaluate(async ({ data }) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error("Thumbnail decode failed"));
      image.src = `data:image/webp;base64,${data}`;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = Math.max(1, Math.round(image.naturalHeight * 256 / image.naturalWidth));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.7).split(",")[1]!;
  }, { data: encoded });
  return { hi, lo: Uint8Array.from(atob(small), (char) => char.charCodeAt(0)) };
}
