import type { Page as BrowserPage } from "@cloudflare/puppeteer";
import { thumbnailCss } from "./thumbnail-css";
import { frameDocument } from "../shared/types";
import { scopeDesign } from "../shared/component-scope";
import type { RenderDesign } from "./render-fonts";

export const MAX_HEIGHT = 8000;
/** Viewport height an auto-height frame first lays out in, before it is fitted to its content. */
export const AUTO_VIEWPORT = 800;
/** Layout passes allowed to fit that viewport to content that keeps changing with it. */
export const FIT_PASSES = 3;
/** Width the sharp preview tier is captured at, at most; narrower frames are never enlarged. */
export const hiScale = (width: number) => Math.min(1, 1280 / width);

/**
 * Authored scripts often build their view after the load event, from a timer or an animation frame. A document
 * that runs any gets this long after load before its classes are read, its height measured and its preview
 * captured; without it, a preview could show a design's markup before its script drew it, at the wrong height.
 */
export const SCRIPT_SETTLE_MS = 250;

/** Whether a document runs authored scripts: in its own HTML or in a component it embeds. */
export function runsScripts(html: string, design: Pick<RenderDesign, "components">) {
  return [html, ...design.components.map((c) => c.html)].some((source) => /<script\b/i.test(source));
}

/** Chunked encoding avoids argument/stack limits for large captures. */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Like @tailwindcss/browser, a stylesheet that fails to compile contributes no CSS instead of failing the capture. */
export const tailwindCss = (input: string, candidates: string[]) => thumbnailCss(input, candidates).catch((err) => {
  console.warn("tailwind compile failed", String(err));
  return "";
});

/**
 * Loads HTML into a browser tab at its viewport width and waits for fonts and Tailwind.
 * Returns the height to capture (fixed height, or measured content height for auto frames).
 *
 * The canvas shows an auto-height frame live in an iframe as tall as its content, so `position: fixed`,
 * sticky bottoms and viewport units resolve against the whole frame there. Previews and screenshots lay it
 * out the same way: the viewport is fitted to the measured height until the content settles.
 */
export async function loadFrame(page: BrowserPage, f: { html: string; width: number; height: number | null }, base: string, design: RenderDesign) {
  const width = Math.max(1, Math.round(f.width));
  design = documentDesign(f.html, design);
  // Seed styles before navigation, so fonts and CSS images load alongside document resources.
  // The DOM pass below covers classes/styles produced by props, slots and authored scripts.
  const { cssSource, candidates } = seedInput(f.html, base, design);
  const seedCss = await tailwindCss(cssSource, candidates);
  // Fresh windows prevent custom element definitions and authored scripts leaking between nodes.
  await page.goto("about:blank");
  const viewportHeight = Math.round(f.height ?? AUTO_VIEWPORT), viewport = page.viewport();
  if (viewport?.width !== width || viewport.height !== viewportHeight || (viewport.deviceScaleFactor ?? 1) !== 1) {
    await page.setViewport({ width, height: viewportHeight });
  }
  await page.setContent(frameDocument(f.html, { base, design, compiledTailwind: true, tailwindCss: seedCss, fontCss: design.fonts }), { waitUntil: "load", timeout: 20_000 });
  // Component expansion has finished parsing, and authored scripts have had their allowance. Read actual
  // classes rather than guessing from source (props, slots, SVG and scripts may create new classes).
  const { css, classes } = await page.evaluate(async (settleMs) => {
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return {
      css: [...document.querySelectorAll('style[type="text/tailwindcss"]')].map((style) => style.textContent).join("\n"),
      classes: [...new Set([...document.querySelectorAll("[class]")].flatMap((el) => [...el.classList]))],
    };
  }, runsScripts(f.html, design) ? SCRIPT_SETTLE_MS : 0);
  const compiled = await tailwindCss(css, classes);
  let measured = await page.evaluate(async ({ css, changed }) => {
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
  if (f.height == null) measured = await fitViewport(page, width, measured);
  return { width, measured, height: Math.min(MAX_HEIGHT, Math.max(1, Math.round(f.height ?? measured))) };
}

/**
 * What a document's first Tailwind pass compiles: its authored `text/tailwindcss` styles (tokens included) and the
 * classes written in its source and in the component definitions it may expand.
 */
/**
 * The part of the design system one document renders with: the components it uses, and the ones those use, as
 * a live canvas iframe gets (see scopeDesign). Components it never mentions would only be defined, never drawn,
 * so the capture is the same; a design system of hundreds of components no longer travels with every document.
 */
export function documentDesign(html: string, design: RenderDesign): RenderDesign {
  const scoped = scopeDesign(html, design);
  return scoped === design ? design : { ...scoped, ...(design.fonts !== undefined ? { fonts: design.fonts } : {}) };
}

/** Characters of a document's own HTML and of the component definitions it embeds: a rough measure of the work to load it. */
export function documentWeight(html: string, design: RenderDesign) {
  return documentDesign(html, design).components.reduce((chars, c) => chars + c.html.length, html.length);
}

const CLASS_ATTRIBUTE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const classNames = (source: string) => [...source.matchAll(CLASS_ATTRIBUTE)].flatMap((match) => (match[1] ?? match[2] ?? match[3]!).split(/\s+/));
/** The classes written in each component definition, read once however many documents embed it. */
const componentClasses = new WeakMap<object, string[]>();

export function seedInput(html: string, base: string, design: RenderDesign) {
  // Component definitions are script text in a document, so its Tailwind styles are those of its head and its own
  // HTML. Leaving the definitions out keeps this from building, and holding, megabytes per document.
  const initial = frameDocument(html, { base, design: { ...design, components: [] }, compiledTailwind: true });
  const cssSource = [...initial.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join("\n");
  const candidates = [...classNames(html), ...design.components.flatMap((c) => {
    let classes = componentClasses.get(c);
    if (!classes) componentClasses.set(c, classes = classNames(c.html));
    return classes;
  })];
  return { cssSource, candidates };
}

/** Resizes the viewport to the content height until the content stops changing with it, and returns that height. */
async function fitViewport(page: BrowserPage, width: number, measured: number) {
  const measure = () => page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const height = Math.min(MAX_HEIGHT, Math.max(1, measured));
    if (page.viewport()?.height === height) return measured;
    await page.setViewport({ width, height });
    const next = await measure();
    if (next === measured) return next;
    measured = next;
  }
  // Content that grows with its viewport, such as a viewport-high section inside a longer page, never settles; the
  // live iframe keeps growing it as well. The preview keeps the first layout rather than one step of that growth.
  await page.setViewport({ width, height: AUTO_VIEWPORT });
  return measure();
}

export async function capture(page: BrowserPage, width: number, height: number, opts: { type: "jpeg" | "webp"; scale: number; quality?: number; transparent?: boolean; x?: number; y?: number; beyondViewport?: boolean }) {
  return (await page.screenshot({
    type: opts.type,
    quality: opts.quality ?? 80,
    clip: { x: opts.x ?? 0, y: opts.y ?? 0, width, height, scale: opts.scale },
    captureBeyondViewport: opts.beyondViewport ?? true,
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
  const hi = await capture(page, width, height, { type: "webp", scale: hiScale(width) });
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
