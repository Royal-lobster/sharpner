// THROWAWAY: measure one browser capture of many isolated, ordinary frameDocument viewports.
// Caller owns the file lock/global browser lease. No persistence, R2 writes, or production protocol.
import puppeteer, { type Page as BrowserPage } from "@cloudflare/puppeteer";
import { frameDocument, type ComponentDef, type DesignSystem } from "../shared/types";
import { prepareRenderDesign } from "./render-fonts";
import { thumbnailCss } from "./thumbnail-css";
import { capture, withTimeout } from "./render";

type Node = { id: string; width: number; height: number | null; measuredHeight?: number | null };
type Source = { id: string; html: string; width: number; height: number | null; theme?: string };
export type OverviewAtlasOptions = {
  binding: Parameters<typeof puppeteer.launch>[0]; design: DesignSystem; base: string; nodes: Node[];
  load: (ids: string[]) => Promise<Source[]>; theme: string | null; side?: number; maxPixels?: number;
  /** Blob mode shares one stylesheet in this fresh, unauthenticated server browser only. */
  cssTransport?: "intercept" | "blob";
};
export type OverviewAtlasResult = {
  imageBase64: string; width: number; height: number; browserMs: number; prepareMs: number; loadMs: number; captureMs: number; sourceBytes: number; cssBytes: number; cssTransport: "intercept" | "blob"; requests: number; resized: string[]; domNodes: number;
  rects: { id: string; x: number; y: number; w: number; h: number; sourceWidth: number; sourceHeight: number }[]; jobs: { id: string; measured: number; domNodes: number }[]; limitations: string[];
};
type Report = { id: string; version: number; measured: number; classes: string[]; domNodes: number; resizeReasons: string[]; error?: string };
type AtlasWindow = Window & {
  __atlas: { frames: Map<string, HTMLIFrameElement>; reports: Map<string, Report>; tokens: Map<string, string>; errors: string[] };
};
const classes = (html: string) => [...html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap(m => (m[1] ?? m[2] ?? m[3]!).split(/\s+/));
const tags = (html: string) => [...html.matchAll(/<\s*(x-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gi)].map(m => m[1]!.toLowerCase());
const quote = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function closure(html: string, components: ComponentDef[]) {
  const used = new Set(tags(html));
  for (let grew = true; grew;) { grew = false; for (const c of components) if (used.has(c.tag)) for (const tag of tags(c.html)) if (!used.has(tag)) { used.add(tag); grew = true; } }
  return components.filter(c => used.has(c.tag));
}
function audit(markup: string) {
  if (/<\s*(?:script|iframe|frame|object|embed|canvas|video|audio|animate|animateMotion|animateTransform|set)\b/i.test(markup)) throw new Error("Atlas static subset excludes authored scripts/embedded or animated content");
  if (/<style\b[^>]*text\/tailwindcss|<meta\b[^>]*http-equiv|\bon(?:load|error|animation\w*|transition\w*|toggle|before\w*)\s*=/i.test(markup)) throw new Error("Atlas excludes per-node Tailwind CSS, HTTP-equivalent metadata and automatic handlers");
  if (/\bautofocus(?:\s|=|>)/i.test(markup)) throw new Error("Atlas excludes automatic focus");
  for (const m of markup.matchAll(/\b(on[\w:-]+)\s*=/gi)) if (!/^on(?:click|dblclick|auxclick|contextmenu|mouse\w*|pointer\w*|touch\w*|key\w*|input|change|submit|reset|select|copy|cut|paste|drag\w*|drop)$/i.test(m[1]!)) throw new Error("Atlas excludes automatic event attributes");
}

/** Stringified into each opaque child. No animation-frame waits while a child is offscreen. */
function childBridge(id: string, token: string, initialViewport: number, isAuto: boolean) {
  let saved: { rect: number[]; style: string }[] | null = null;
  const signature = () => [...document.querySelectorAll("*")].filter(e => !["script", "style", "link", "meta", "head", "html"].includes(e.localName)).map(e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return { rect: [r.x, r.y, r.width, r.height], style: [s.color, s.backgroundColor, s.fontFamily, s.fontSize, s.lineHeight, s.visibility, s.opacity, s.transform].join("|") };
  });
  const send = async (version: number, changedCss = false, resized = false) => {
    try {
      document.body.getBoundingClientRect(); await document.fonts.ready;
      if ([...document.fonts].some(f => f.status === "error" || f.status === "loading")) throw new Error("font-not-ready");
      await Promise.all([...document.images].map(image => image.complete ? (image.naturalWidth ? Promise.resolve() : Promise.reject(new Error("image-failed"))) : new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("image-failed")); })));
      const elements = [...document.querySelectorAll("*")], resizeReasons = new Set<string>();
      if (elements.length > 100_000) throw new Error("per-document-dom-budget");
      if (document.getAnimations().some(animation => animation.playState === "running")) throw new Error("running-motion-outside-static-subset");
      const measured = Math.ceil(document.body.getBoundingClientRect().height);
      if (isAuto && measured > initialViewport) {
        if (innerWidth !== document.documentElement.clientWidth) resizeReasons.add("scrollbar-width-change");
        const scan = (rules: CSSRuleList) => { for (const rule of rules) {
          const nested = rule as CSSRule & { cssRules?: CSSRuleList; conditionText?: string; selectorText?: string; style?: CSSStyleDeclaration };
          if (nested.conditionText && /height|orientation|aspect-ratio/i.test(nested.conditionText)) resizeReasons.add("height-dependent-condition");
          if (nested.style && nested.selectorText && /(?:\d(?:\.\d+)?(?:[dsl]?vh|vmin|vmax)\b|background-attachment\s*:\s*fixed)/i.test(nested.style.cssText)) {
            try { if (document.querySelector(nested.selectorText.replace(/::[\w-]+(?:\([^)]*\))?/g, ""))) resizeReasons.add("height-viewport-css"); } catch { resizeReasons.add("unresolved-css-selector"); }
          }
          if (nested.cssRules) scan(nested.cssRules);
        } };
        for (const sheet of document.styleSheets) {
          if (sheet.href && new URL(sheet.href).hostname === "fonts.googleapis.com") continue;
          try { scan(sheet.cssRules); } catch { resizeReasons.add("unreadable-external-stylesheet"); }
        }
        for (const element of elements) {
          const s = getComputedStyle(element), inline = element.getAttribute("style") ?? "";
          if (s.position === "fixed" || s.position === "sticky" || s.backgroundAttachment === "fixed") resizeReasons.add("viewport-positioning");
          if (/\d(?:\.\d+)?(?:[dsl]?vh|vmin|vmax)\b/i.test(inline)) resizeReasons.add("inline-height-viewport-unit");
        }
      }
      if (changedCss) {
        const urls = new Set<string>();
        for (const element of elements) for (const pseudo of [null, "::before", "::after"]) {
          const s = getComputedStyle(element, pseudo);
          for (const value of [s.backgroundImage, s.maskImage, s.listStyleImage]) for (const m of value.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(m[1]!);
        }
        await Promise.all([...urls].map(url => new Promise<void>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error("css-image-failed")); image.src = url; })));
      }
      if (resized && saved) {
        const after = signature();
        if (after.length !== saved.length || after.some((v, i) => v.style !== saved![i]!.style || v.rect.some((value, k) => Math.abs(value - saved![i]!.rect[k]!) > .1))) resizeReasons.add("layout-or-style-changed-on-resize");
      } else if (isAuto && measured > initialViewport) saved = signature();
      parent.postMessage({ type: "atlas-child", token, value: { id, version, measured, classes: [...new Set(elements.flatMap(e => [...e.classList]))], domNodes: elements.length, resizeReasons: [...resizeReasons] } }, "*");
    } catch (error) { parent.postMessage({ type: "atlas-child", token, value: { id, version, error: String(error) } }, "*"); }
  };
  addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || data?.token !== token) return;
    if (data.type === "atlas-css") { const link = document.querySelector<HTMLLinkElement>("link[data-atlas-css]")!; link.onload = () => void send(data.version, true); link.onerror = () => parent.postMessage({ type: "atlas-child", token, value: { id, version: data.version, error: "css-load-failed" } }, "*"); link.href = data.href; }
    if (data.type === "atlas-resized") void send(data.version, false, true);
  });
  addEventListener("load", () => void send(1), { once: true });
}

export async function renderOverviewAtlas(options: OverviewAtlasOptions) {
  if (!options.nodes.length || options.nodes.length > 300 || new Set(options.nodes.map(n => n.id)).size !== options.nodes.length) throw new Error("Atlas needs 1–300 unique frames");
  const side = Math.max(32, Math.min(256, Math.round(options.side ?? 128))), maxPixels = Math.min(16_000_000, Math.max(1, options.maxPixels ?? 16_000_000));
  for (const n of options.nodes) if (![n.width, n.height ?? 800].every(Number.isFinite) || n.width < 1 || n.width > 4000 || n.height !== null && (n.height < 1 || n.height > 8000)) throw new Error("Atlas frame geometry outside budget");
  const preparing = performance.now(), design = await prepareRenderDesign(options.design), candidates = new Set(design.components.flatMap(c => classes(c.html)));
  let sourceBytes = 0;
  for (let i = 0; i < options.nodes.length; i += 8) for (const n of await options.load(options.nodes.slice(i, i + 8).map(n => n.id))) {
    sourceBytes += new TextEncoder().encode(n.html).byteLength; if (sourceBytes > 32 * 1024 * 1024) throw new Error("Atlas source budget (32 MiB)");
    audit([n.html, ...closure(n.html, design.components).map(c => c.html)].join("\n")); for (const c of classes(n.html)) candidates.add(c);
  }
  if (candidates.size > 20_000) throw new Error("Atlas class budget");
  const empty = frameDocument("", { design, compiledTailwind: true });
  const cssSource = [...empty.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]!).join("\n");
  // Moving a file stylesheet must not silently change the base of its resources or SVG fragments.
  for (const match of cssSource.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi)) {
    if (!/^(?:https?:\/\/|data:)/i.test(match[1] ?? match[2] ?? match[3]!)) throw new Error("Atlas file CSS contains an unresolved relative resource");
  }
  let sheet = await thumbnailCss(cssSource, [...candidates]); const prepareMs = performance.now() - preparing;
  if (sheet.length > 8 * 1024 * 1024) throw new Error("Atlas stylesheet budget");
  const cssTransport = options.cssTransport ?? "intercept", blobMode = cssTransport === "blob";
  const cssUrl = "https://sharpner-atlas.invalid/shared.css", strippedDesign = { ...design, tokens: "" };
  const imports = [...empty.matchAll(/<link\b[^>]*rel=["\']stylesheet["\'][^>]*>/gi)].map(m => m[0]).join("");
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined, pageToClean: BrowserPage | undefined, stopped = false, result: Omit<OverviewAtlasResult, "browserMs"> | undefined, failure: unknown;
  const blobUrls = new Set<string>();
  const started = Date.now();
  try {
    result = await withTimeout((async () => {
      browser = await puppeteer.launch(options.binding, { keep_alive: 10_000 });
      if (stopped) { await browser.close(); throw new Error("Atlas launch exceeded deadline"); }
      const page = await browser.newPage(); pageToClean = page; await page.setViewport({ width: side * Math.min(8, options.nodes.length), height: 800, deviceScaleFactor: 1 });
      let requests = 0;
      if (blobMode) page.on("request", () => { if (++requests > 4096) void page.close().catch(() => {}); });
      else {
        await page.setRequestInterception(true);
        page.on("request", request => { void (async () => {
          if (++requests > 4096) return request.abort();
          if (request.url().startsWith(cssUrl)) return request.respond({ status: 200, contentType: "text/css", headers: { "access-control-allow-origin": "*", "cache-control": "public,max-age=3600" }, body: sheet });
          return /^(?:https?:|data:|about:)/.test(request.url()) ? request.continue() : request.abort();
        })().catch(() => {}); });
      }
      await page.setContent("<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}</style>", { waitUntil: "load" });
      const stylesheetUrl = async (css: string) => {
        const url = await page.evaluate(css => URL.createObjectURL(new Blob([css], { type: "text/css" })), css);
        blobUrls.add(url); return url;
      };
      let activeCssUrl = blobMode ? await stylesheetUrl(sheet) : `${cssUrl}?v=1`;
      await page.evaluate(() => {
        const state = { frames: new Map<string, HTMLIFrameElement>(), reports: new Map<string, Report>(), tokens: new Map<string, string>(), errors: [] as string[] }; (window as unknown as AtlasWindow).__atlas = state;
        addEventListener("message", event => { const data = event.data, record = data?.value as Report; if (data?.type !== "atlas-child" || !record || state.tokens.get(record.id) !== data.token || state.frames.get(record.id)?.contentWindow !== event.source) return; state.reports.set(record.id, record); if (record.error) state.errors.push(`${record.id}: ${record.error}`); });
      });
      const loading = performance.now();
      for (let i = 0; i < options.nodes.length; i += 8) {
        const loaded = await options.load(options.nodes.slice(i, i + 8).map(n => n.id));
        const docs = loaded.map(n => {
          const token = crypto.randomUUID(), nonce = crypto.randomUUID(), width = Math.max(1, Math.round(n.width)), viewportHeight = Math.round(n.height ?? 800);
          const policy = `default-src 'none';script-src 'nonce-${nonce}';style-src 'unsafe-inline' ${blobMode ? "blob: " : ""}https: ${new URL(options.base).origin};font-src data: https:;img-src data: https: ${new URL(options.base).origin};connect-src 'none';frame-src 'none';object-src 'none';worker-src 'none';media-src 'none';form-action 'none'`;
          let doc = frameDocument(n.html, { base: options.base, design: { ...strippedDesign, components: closure(n.html, strippedDesign.components) }, theme: n.theme ?? options.theme, compiledTailwind: true }).replace(/<script\b/g, `<script nonce="${nonce}"`);
          doc = doc.replace(/<head\b[^>]*>/i, h => h + `<meta http-equiv="Content-Security-Policy" content="${quote(policy)}"><link data-atlas-css rel="stylesheet" crossorigin="anonymous" href="${quote(activeCssUrl)}">${imports}`);
          const script = `<script nonce="${nonce}">(${childBridge.toString()})(${JSON.stringify(n.id)},${JSON.stringify(token)},${viewportHeight},${n.height === null})</script>`;
          doc = /<\/body\s*>/i.test(doc) ? doc.replace(/<\/body\s*>/i, end => script + end) : doc + script;
          return { id: n.id, doc, width, viewportHeight, token };
        });
        // Same-origin is opt-in only inside this empty server browser. Never reuse this policy in the editor.
        await page.evaluate(({ docs, blobMode }) => { const state = (window as unknown as AtlasWindow).__atlas; for (const n of docs) { const frame = document.createElement("iframe"); frame.sandbox.add("allow-scripts"); if (blobMode) frame.sandbox.add("allow-same-origin"); frame.style.cssText = `position:absolute;left:0;top:0;width:${n.width}px;height:${n.viewportHeight}px;border:0;transform-origin:0 0;pointer-events:none`; frame.width = String(n.width); frame.height = String(n.viewportHeight); state.frames.set(n.id, frame); state.tokens.set(n.id, n.token); const cell = document.createElement("div"); cell.style.cssText = `position:absolute;left:0;top:0;width:${n.width}px;height:${n.viewportHeight}px;overflow:hidden`; cell.appendChild(frame); document.body.appendChild(cell); frame.srcdoc = n.doc; } }, { docs, blobMode });
      }
      const wait = async (version: number) => {
        await page.waitForFunction((count, version) => { const s = (window as unknown as AtlasWindow).__atlas; return s.errors.length > 0 || s.reports.size === count && [...s.reports.values()].every(r => r.version >= version); }, { polling: 30, timeout: 12_000 }, options.nodes.length, version);
        return page.evaluate(() => { const s = (window as unknown as AtlasWindow).__atlas; if (s.errors.length) throw new Error(s.errors.join("; ")); return [...s.reports.values()]; });
      };
      let reports = await wait(1);
      for (const report of reports) for (const c of report.classes) candidates.add(c);
      if (candidates.size > 20_000 || reports.reduce((n, r) => n + r.domNodes, 0) > 500_000) throw new Error("Atlas expanded class/DOM budget");
      const expanded = await thumbnailCss(cssSource, [...candidates]); let version = 1;
      if (expanded !== sheet) {
        sheet = expanded; version++; const previousCssUrl = activeCssUrl;
        activeCssUrl = blobMode ? await stylesheetUrl(sheet) : `${cssUrl}?v=${version}`;
        await page.evaluate(({ href, version }) => { const s = (window as unknown as AtlasWindow).__atlas; for (const [id, f] of s.frames) f.contentWindow!.postMessage({ type: "atlas-css", token: s.tokens.get(id), href, version }, "*"); }, { href: activeCssUrl, version }); reports = await wait(version);
        if (blobMode) { await page.evaluate(url => URL.revokeObjectURL(url), previousCssUrl); blobUrls.delete(previousCssUrl); }
      }
      const heights = new Map(reports.map(r => [r.id, r])), resized: string[] = [];
      for (const n of options.nodes) if (n.height === null && heights.get(n.id)!.measured > 800) { const report = heights.get(n.id)!; if (report.resizeReasons.length) throw new Error(`Atlas auto-height viewport dependency: ${n.id}: ${report.resizeReasons.join(",")}`); resized.push(n.id); }
      if (resized.length) {
        version++; await page.evaluate(({ items, version }) => { const s = (window as unknown as AtlasWindow).__atlas; for (const item of items) { const f = s.frames.get(item.id)!; f.style.height = `${item.height}px`; f.contentWindow!.postMessage({ type: "atlas-resized", token: s.tokens.get(item.id), version }, "*"); } for (const [id, report] of s.reports) if (!items.some(item => item.id === id)) report.version = version; }, { items: resized.map(id => ({ id, height: Math.min(8000, heights.get(id)!.measured) })), version });
        reports = await wait(version); for (const r of reports) if (r.resizeReasons.length && resized.includes(r.id)) throw new Error(`Atlas resize changed rendering: ${r.id}: ${r.resizeReasons.join(",")}`);
      }
      const columns = Math.min(8, options.nodes.length), bottoms = Array<number>(columns).fill(0), rects = options.nodes.map(n => {
        const sourceWidth = Math.round(n.width), sourceHeight = Math.min(8000, Math.max(1, Math.round(n.height ?? heights.get(n.id)!.measured))), w = Math.max(1, Math.round(Math.min(1, side / sourceWidth) * sourceWidth)), h = Math.max(1, Math.ceil(sourceHeight * w / sourceWidth));
        const column = bottoms.indexOf(Math.min(...bottoms)), x = column * side, y = bottoms[column]!; bottoms[column] = y + h; return { id: n.id, x, y, w, h, sourceWidth, sourceHeight };
      });
      const width = columns * side, height = Math.max(...bottoms); if (height > 8000 || width * height > maxPixels) throw new Error("Atlas capture exceeds height/pixel budget");
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.evaluate(rects => { const s = (window as unknown as AtlasWindow).__atlas; for (const r of rects) { const f = s.frames.get(r.id)!; const cell = f.parentElement!; cell.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;overflow:hidden`; f.style.transform = `scale(${r.w / r.sourceWidth})`; } }, rects);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const loadMs = performance.now() - loading, capturing = performance.now(), image = await capture(page, width, height, { type: "webp", scale: 1, quality: 70 }), captureMs = performance.now() - capturing;
      let binary = ""; for (let i = 0; i < image.length; i += 8192) binary += String.fromCharCode(...image.subarray(i, i + 8192));
      return { imageBase64: btoa(binary), width, height, rects, prepareMs, loadMs, captureMs, sourceBytes, cssBytes: sheet.length, cssTransport, requests, resized, domNodes: reports.reduce((n, r) => n + r.domNodes, 0), jobs: reports.map(r => ({ id: r.id, measured: r.measured, domNodes: r.domNodes })), limitations: ["static-documents-only", ...(blobMode ? ["same-origin-only-inside-fresh-unauthenticated-server-browser"] : []), "auto-height-resize-requires-css-and-geometry-check", "scrollbar-and-compositor-pixel-goldens-still-required"] };
    })(), 20_000, "atlas session");
  } catch (error) { failure = error;
  } finally {
    stopped = true;
    if (pageToClean && blobUrls.size) try { await withTimeout(pageToClean.evaluate(urls => { for (const url of urls) URL.revokeObjectURL(url); }, [...blobUrls]), 1000, "atlas blob cleanup"); } catch { /* Browser close also releases its blob registry. */ }
    if (browser) await withTimeout(browser.close(), 5000, "atlas browser close");
  }
  if (failure) throw new Error(`Atlas failed after ${Date.now() - started} browser-ms: ${String(failure)}`);
  if (!result) throw new Error("Atlas produced no capture");
  return { ...result, browserMs: Date.now() - started };
}
