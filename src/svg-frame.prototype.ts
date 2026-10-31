// THROWAWAY PROTOTYPE — local HTML-to-SVG rasterization, never a server screenshot.
// Strictly limited to declarative HTML. A false capability result must keep a faithful fallback.
import { frameDocument } from "../shared/types";
import type { PrototypeFrame, PrototypeReady, PrototypeSurface } from "./frame-surface.prototype";

const MAX_CAPTURES = 4;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_DOM_NODES = 4000;
const UPDATE_BUDGET_MS = 6000;
const DOCUMENT_TIMEOUT_MS = 1500;
const DECODE_TIMEOUT_MS = 1500;
let active = 0;
const waiters: (() => void)[] = [];
const resourceCache = new Map<string, { result: Promise<{ data: string; bytes: number }>; bytes: number }>();
let cachedBytes = 0;

async function acquire(notAfter: number) {
  if (active >= MAX_CAPTURES) await new Promise<void>((resolve, reject) => {
    const grant = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("SVG capture queue exceeded update budget"));
    }, Math.max(1, notAfter - performance.now()));
    waiters.push(grant);
  });
  else active++;
  return () => { const next = waiters.shift(); if (next) next(); else active--; };
}

function within<T>(promise: Promise<T>, notAfter: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} exceeded SVG update budget`)), Math.max(1, notAfter - performance.now()));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function base64(bytes: Uint8Array) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}

async function boundedBytes(response: Response, limit: number) {
  if (!response.ok) throw new Error(`Resource returned ${response.status}`);
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Resource exceeds capture byte limit");
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel(); throw new Error("Resource exceeds capture byte limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function assetUrl(input: string, base = location.origin) {
  if (/^data:/i.test(input)) return input;
  const url = new URL(input, base);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported capture resource protocol: ${url.protocol}`);
  if (url.origin === location.origin && /^\/(?:api|auth|mcp|\.well-known)(?:\/|$)/.test(url.pathname)) {
    throw new Error("Capture resources cannot read application API routes");
  }
  return url.href;
}

async function dataResource(input: string, budget: { bytes: number }, base?: string) {
  const url = assetUrl(input, base);
  if (url.startsWith("data:")) return url;
  let entry = resourceCache.get(url);
  if (!entry) {
    const result = (async () => {
      const response = await fetch(url, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(8000) });
      const bytes = await boundedBytes(response, MAX_RESOURCE_BYTES);
      const mime = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
      if (!/^(?:image\/|font\/|application\/(?:font|x-font|octet-stream))/.test(mime)) throw new Error(`Unsupported capture resource type: ${mime}`);
      return { data: `data:${mime};base64,${base64(bytes)}`, bytes: bytes.length };
    })();
    entry = { result, bytes: 0 };
    resourceCache.set(url, entry);
    const own = entry;
    void result.then(({ bytes }) => {
      if (resourceCache.get(url) !== own) return;
      own.bytes = bytes; cachedBytes += bytes;
      while (cachedBytes > MAX_CACHE_BYTES || resourceCache.size > 64) {
        const key = resourceCache.keys().next().value!;
        cachedBytes -= resourceCache.get(key)!.bytes;
        resourceCache.delete(key);
      }
    }, () => { if (resourceCache.get(url) === own) resourceCache.delete(url); });
  }
  const result = await entry.result;
  budget.bytes += result.bytes;
  if (budget.bytes > MAX_CAPTURE_BYTES) throw new Error("Frame assets exceed capture byte limit");
  return result.data;
}

const stylesheetCache = new Map<string, Promise<string>>();
async function stylesheet(href: string, budget: { bytes: number }, depth = 0): Promise<string> {
  const url = assetUrl(href);
  if (depth > 3) throw new Error("Nested CSS imports exceed capture limit");
  let result = stylesheetCache.get(url);
  if (!result) {
    result = (async () => {
      const response = await fetch(url, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(8000) });
      const bytes = await boundedBytes(response, 512 * 1024);
      if (!/text\/css/.test(response.headers.get("content-type") ?? "")) throw new Error("Capture stylesheet did not return CSS");
      return new TextDecoder().decode(bytes);
    })();
    stylesheetCache.set(url, result);
    while (stylesheetCache.size > 16) stylesheetCache.delete(stylesheetCache.keys().next().value!);
    void result.catch(() => { if (stylesheetCache.get(url) === result) stylesheetCache.delete(url); });
  }
  return embedCss(await result, budget, url, depth);
}

async function embedCss(css: string, budget: { bytes: number }, base = location.origin, depth = 0): Promise<string> {
  const imports = [...css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?\s*([^;]*);/g)];
  for (const [declaration, href, condition] of imports) {
    if (condition?.trim()) throw new Error("Conditional CSS imports are unsupported by this capture prototype");
    css = css.replace(declaration, await stylesheet(new URL(href!, base).href, budget, depth + 1));
  }
  const urls = [...new Set([...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]!.trim()).filter((url) => !url.startsWith("data:") && !url.startsWith("#")))];
  if (urls.length > 64) throw new Error("Too many resources in capture stylesheet");
  // Four upstream reads at a time, independently of frame capture concurrency.
  const queue = [...urls];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const data = await dataResource(url, budget, base);
      css = css.split(url).join(data);
    }
  }));
  return css;
}

function captureRuntime(config: { token: string; width: number; maxNodes: number }) {
  const send = (value: unknown) => parent.postMessage({ sharpnerSvgPrototype: config.token, ...value as object }, "*");
  const finish = async () => {
    try {
      send({ stage: "font-load" });
      document.body.getBoundingClientRect();
      // FontFaceSet.ready can wait for a rendering update indefinitely in a hidden iframe.
      // Resource-level FontFace.loaded promises do not need a foreground animation frame.
      const loading = [...document.fonts].filter((face) => face.status === "loading");
      await Promise.race([
        Promise.all(loading.map((face) => face.loaded)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Hidden-frame web fonts did not settle within 500ms")), 500)),
      ]);
      document.body.getBoundingClientRect();
      send({ stage: "serialize" });
      const elements = [document.documentElement, ...document.documentElement.querySelectorAll("*")];
      if (elements.length > config.maxNodes) throw new Error("Frame exceeds capture DOM-node limit");
      if (document.querySelector("canvas,video,audio,iframe,object,embed")) throw new Error("Canvas, video, audio and embedded documents require a real browser surface");
      const copy = document.documentElement.cloneNode(true) as HTMLElement;
      const clones = [copy, ...copy.querySelectorAll("*")];
      const urls = new Set<string>();
      let pseudoCss = "";
      const frozen = ["width", "height", "min-width", "min-height", "max-width", "max-height", "font-size", "line-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "transform", "transform-origin", "box-shadow", "text-shadow"];
      const check = (style: CSSStyleDeclaration) => {
        if (style.position === "fixed") throw new Error("Fixed positioning requires a faithful viewport-aware capture");
        if (style.backdropFilter !== "none" && style.backdropFilter !== "") throw new Error("Backdrop filters are not faithfully captured by foreignObject");
        if (style.animationName !== "none" && style.animationName !== "") throw new Error("Animated styles are unsupported by a static SVG capture");
        for (const value of [style.backgroundImage, style.maskImage, style.borderImageSource, style.listStyleImage, style.content]) {
          for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
            const url = match[1]!.trim(); if (!url.startsWith("data:") && !url.startsWith("#")) urls.add(new URL(url, document.baseURI).href);
          }
        }
      };
      for (let i = 0; i < elements.length; i++) {
        const original = elements[i]!, clone = clones[i]!;
        if (original.localName === "script" || original.localName === "base" || original.localName === "link" || original.localName === "meta") { clone.remove(); continue; }
        if (original.getAttributeNames().some((name) => /^on/i.test(name))) throw new Error("Author event handlers are unsupported by this capture prototype");
        if (original.shadowRoot) throw new Error("Nested shadow roots are not serialized by this capture prototype");
        const style = getComputedStyle(original); check(style);
        if (clone instanceof HTMLElement || clone instanceof SVGElement) {
          for (const property of frozen) clone.style.setProperty(property, style.getPropertyValue(property), "important");
        }
        for (const pseudo of ["::before", "::after"]) {
          const state = getComputedStyle(original, pseudo);
          if (state.content === "none" || state.content === "normal" || state.content === "") continue;
          check(state);
          clone.setAttribute("data-svg-prototype", String(i));
          const declarations = frozen.concat(["top", "right", "bottom", "left"]).map((property) => `${property}:${state.getPropertyValue(property)}!important`).join(";");
          pseudoCss += `[data-svg-prototype="${i}"]${pseudo}{${declarations}}`;
        }
        if (original instanceof HTMLImageElement) {
          if (!original.complete || !original.naturalWidth) throw new Error("Frame contains a failed or incomplete image");
          const url = original.currentSrc || original.src;
          clone.removeAttribute("srcset"); clone.removeAttribute("sizes"); clone.setAttribute("src", url);
          if (!url.startsWith("data:")) urls.add(url);
        }
        if (original instanceof SVGImageElement) {
          const url = original.href.baseVal;
          if (url && !url.startsWith("data:") && !url.startsWith("#")) {
            const resolved = new URL(url, document.baseURI).href;
            clone.setAttribute("href", resolved); urls.add(resolved);
          }
        }
        if (original instanceof HTMLInputElement) {
          clone.setAttribute("value", original.value);
          if (original.checked) clone.setAttribute("checked", ""); else clone.removeAttribute("checked");
        }
        if (original instanceof HTMLTextAreaElement) clone.textContent = original.value;
        if (original instanceof HTMLOptionElement) {
          if (original.selected) clone.setAttribute("selected", ""); else clone.removeAttribute("selected");
        }
      }
      copy.querySelectorAll('style[type="text/tailwindcss"]').forEach((style) => style.remove());
      if (pseudoCss) { const style = document.createElement("style"); style.textContent = pseudoCss; copy.querySelector("head")!.appendChild(style); }
      const root = getComputedStyle(document.documentElement);
      for (const property of ["font-family", "font-size", "color", "color-scheme", "line-height"]) copy.style.setProperty(property, root.getPropertyValue(property), "important");
      const measuredHeight = Math.ceil(document.body.getBoundingClientRect().height);
      send({ html: new XMLSerializer().serializeToString(copy), urls: [...urls], measuredHeight });
    } catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); }
  };
  send({ stage: "runtime" });
  if (document.readyState !== "loading") void finish(); else addEventListener("DOMContentLoaded", () => void finish(), { once: true });
}

function escapeXml(text: string) { return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function mountSvgFrame(host: HTMLElement): PrototypeSurface {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
  host.appendChild(canvas);
  let generation = 0, disposed = false;
  let cancelCapture: (() => void) | null = null;
  return {
    async update(frame: PrototypeFrame): Promise<PrototypeReady> {
      const ownGeneration = ++generation;
      const notAfter = performance.now() + UPDATE_BUDGET_MS;
      canvas.dataset.svgPrototypeStage = "queue";
      cancelCapture?.();
      const width = Math.max(1, Math.round(frame.width));
      let measuredHeight = frame.height ?? 800;
      const fresh = () => !disposed && ownGeneration === generation;
      let release: (() => void) | undefined;
      try {
        release = await acquire(notAfter);
        const remaining = (limit: number) => Math.max(1, Math.min(limit, notAfter - performance.now()));
        const checkDeadline = () => { if (performance.now() >= notAfter) throw new Error("SVG capture exceeded update budget"); };
        checkDeadline();
        canvas.dataset.svgPrototypeStage = "resources";
        if (!fresh()) return { measuredHeight, supported: false, reason: "Capture superseded" };
        const authored = [frame.html, ...frame.design.components.map((component) => component.html)].join("\n");
        if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(authored)) throw new Error("Author scripts/event handlers are unsupported by SVG capture");
        const budget = { bytes: 0 };
        let css = await within(embedCss(frame.css, budget), notAfter, "Stylesheet preparation");
        const design = { ...frame.design, tokens: frame.design.tokens };
        const imports = [...design.tokens.matchAll(/@import\s+(?:url\()?\s*["']?(https?:[^"')\s]+)["']?\s*\)?[^;]*;/g)];
        if (imports.length > 8) throw new Error("Frame imports too many font stylesheets for capture");
        for (const [declaration, href] of imports) {
          css += await within(stylesheet(href!, budget), notAfter, "Font preparation");
          design.tokens = design.tokens.replace(declaration, "");
        }
        let html = frame.html;
        for (const match of [...html.matchAll(/<link\b[^>]*>/gi)]) {
          const template = document.createElement("template"); template.innerHTML = match[0];
          const link = template.content.querySelector("link");
          if (link?.rel === "stylesheet" && link.getAttribute("href")) {
            const sheet = await within(stylesheet(new URL(link.getAttribute("href")!, location.origin).href, budget), notAfter, "Authored stylesheet");
            html = html.replace(match[0], `<style>${sheet.replace(/<\//g, "<\\/")}</style>`);
          }
        }
        for (const [tag, attributes, body] of [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)]) {
          if (/text\/tailwindcss/i.test(attributes!)) continue;
          const embedded = await within(embedCss(body!, budget), notAfter, "Authored styles");
          html = html.replace(tag, `<style${attributes}>${embedded.replace(/<\//g, "<\\/")}</style>`);
        }
        checkDeadline();
        canvas.dataset.svgPrototypeStage = "document";
        const token = crypto.randomUUID();
        const iframe = document.createElement("iframe");
        iframe.sandbox.add("allow-scripts");
        iframe.tabIndex = -1; iframe.setAttribute("aria-hidden", "true");
        // It must participate in layout. display:none prevents reliable web-font/height measurement.
        iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${Math.max(1, Math.round(frame.height ?? 800))}px;border:0;pointer-events:none;opacity:0`;
        const snapshot = await new Promise<{ html: string; urls: string[]; measuredHeight: number }>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const cleanup = () => { clearTimeout(timer); removeEventListener("message", receive); iframe.remove(); if (cancelCapture === cancel) cancelCapture = null; };
          const cancel = () => { cleanup(); reject(new Error("Capture superseded")); };
          const receive = (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow || event.data?.sharpnerSvgPrototype !== token) return;
            if (event.data.stage) { canvas.dataset.svgPrototypeStage = String(event.data.stage); return; }
            cleanup();
            if (event.data.error) reject(new Error(String(event.data.error)));
            else if (typeof event.data.html === "string" && Array.isArray(event.data.urls) && Number.isFinite(event.data.measuredHeight)) resolve(event.data);
            else reject(new Error("Malformed SVG capture response"));
          };
          cancelCapture = cancel;
          addEventListener("message", receive);
          timer = setTimeout(() => { cleanup(); reject(new Error(`SVG capture document timed out at ${canvas.dataset.svgPrototypeStage}`)); }, remaining(DOCUMENT_TIMEOUT_MS));
          const probe = `<script>(${captureRuntime.toString()})(${JSON.stringify({ token, width, maxNodes: MAX_DOM_NODES })})</script>`;
          const documentHtml = frameDocument(html, { base: location.origin, design, theme: frame.theme, compiledTailwind: true, tailwindCss: css });
          iframe.srcdoc = documentHtml.replace(/<\/body>/i, `${probe}</body>`);
          document.body.appendChild(iframe);
        });
        checkDeadline();
        measuredHeight = snapshot.measuredHeight;
        if (!fresh()) return { measuredHeight, supported: false, reason: "Capture superseded" };
        if (snapshot.html.length > MAX_SERIALIZED_BYTES) throw new Error("Serialized capture exceeds byte limit");
        if (snapshot.urls.length > 64) throw new Error("Frame has too many capture resources");
        let serialized = snapshot.html;
        const queue = [...new Set(snapshot.urls)];
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let url = queue.shift(); url; url = queue.shift()) {
            const data = await within(dataResource(url, budget), notAfter, "Image preparation");
            serialized = serialized.split(escapeXml(url)).join(data).split(url).join(data);
          }
        }));
        checkDeadline();
        canvas.dataset.svgPrototypeStage = "image-decode";
        const height = Math.max(1, Math.min(8000, Math.round(frame.height ?? measuredHeight)));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${serialized}</foreignObject></svg>`;
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { image.src = ""; reject(new Error("SVG image decode timed out")); }, remaining(DECODE_TIMEOUT_MS));
          image.onload = () => { clearTimeout(timer); resolve(); };
          image.onerror = () => { clearTimeout(timer); reject(new Error("Browser rejected SVG foreignObject image")); };
          image.src = `data:image/svg+xml;base64,${base64(new TextEncoder().encode(svg))}`;
        });
        if (!fresh()) return { measuredHeight, supported: false, reason: "Capture superseded" };
        checkDeadline();
        canvas.dataset.svgPrototypeStage = "paint";
        const visiblePixels = Math.ceil(frame.pixelWidth ?? host.getBoundingClientRect().width * devicePixelRatio);
        canvas.width = Math.max(1, Math.min(width, 1280, Math.max(256, visiblePixels)));
        canvas.height = Math.max(1, Math.round(height * canvas.width / width));
        host.style.width = `${width}px`; host.style.height = `${height}px`;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        // Detect taint now. A visible but unreadable foreignObject cannot feed Sharpner's raster layer.
        context.getImageData(0, 0, 1, 1);
        image.src = "";
        canvas.dataset.svgPrototypeAssetBytes = String(budget.bytes);
        canvas.dataset.svgPrototypeSerializedBytes = String(serialized.length);
        canvas.dataset.svgPrototypeStage = "ready";
        return { measuredHeight, supported: true, domNodes: host.querySelectorAll("*").length };
      } catch (error) {
        canvas.dataset.svgPrototypeStage = "unsupported";
        canvas.dataset.svgPrototypeReason = error instanceof Error ? error.message : String(error);
        return { measuredHeight, supported: false, reason: error instanceof Error ? error.message : String(error), domNodes: host.querySelectorAll("*").length };
      } finally { release?.(); }
    },
    dispose() { disposed = true; generation++; cancelCapture?.(); canvas.remove(); },
  };
}
