import type { Page as BrowserPage } from "@cloudflare/puppeteer";
import { frameDocument, type DesignSystem } from "../shared/types";

const MAX_HEIGHT = 8000;

/**
 * Loads HTML into a browser tab at its viewport width and waits for fonts and Tailwind.
 * Returns the height to capture (fixed height, or measured content height for auto frames).
 */
export async function loadFrame(page: BrowserPage, f: { html: string; width: number; height: number | null; theme?: string | null }, base: string, design: DesignSystem) {
  const width = Math.max(1, Math.round(f.width));
  // A fresh document (and window) per render, so nothing — e.g. custom element definitions — leaks between nodes.
  await page.goto("about:blank");
  await page.setViewport({ width, height: Math.round(f.height ?? 800) });
  // "load" covers the Tailwind script, stylesheets and images; then wait for web fonts and let Tailwind
  // flush its generated styles. (No requestAnimationFrame: it never fires in background tabs.)
  await page.setContent(frameDocument(f.html, { base, design, theme: f.theme }), { waitUntil: "load", timeout: 20_000 });
  const measured = await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 50));
    return Math.ceil(document.body.getBoundingClientRect().height);
  });
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
