import type { Page as BrowserPage } from "@cloudflare/puppeteer";
import { frameDocument } from "../shared/types";
import { AUTO_VIEWPORT, bytesToBase64, capture, documentDesign, FIT_PASSES, hiScale, MAX_HEIGHT, runsScripts, SCRIPT_SETTLE_MS, seedInput, tailwindCss } from "./render";
import { pruneFontFaces, type RenderDesign } from "./render-fonts";

/**
 * A sprite renders many previews from one browser page. Each node keeps its own document in a same-origin srcdoc
 * iframe at its own width, so viewport units, media queries, fixed positioning, root styles, custom element
 * definitions and authored scripts resolve exactly as in a page of its own. The page is loaded, styled, fitted and
 * laid out once; each node is then captured from its own rectangle with its own scale.
 */
export type SpriteJob = {
  id: string; html: string; width: number; height: number | null; measuredHeight?: number | null;
  /** Characters of the node's HTML and the component definitions it embeds (`documentWeight`), for planning. */
  weight?: number;
};
export type SpriteCapture = { width: number; measured: number; height: number; hi: Uint8Array; lo: Uint8Array };
/** `fallback` nodes did not render in the sprite (slow to load, never settled, or no room) and render on their own. */
export type SpriteResult = { captured: Map<string, SpriteCapture>; fallback: string[]; phases: SpritePhases };
/** Milliseconds per stage of one sprite, for the turn log. */
export type SpritePhases = {
  seed: number; load: number; settle: number; capture: number; encode: number;
  /** Of `load`, the time the page itself spent: fonts to blob URLs and every document loaded. The rest is transfer. */
  pageLoad: number;
  /** Kilobytes of documents and fonts sent to the page. */
  sentKB: number;
};

export const SPRITE_LIMITS = {
  /** Nodes in one sprite. */
  nodes: 24,
  /** Sprite page size. Nodes that would land below `height` render on their own. */
  width: 4096,
  height: 16_384,
  /** Planned area of one sprite, from each node's known or estimated height. */
  pixels: 32 * 1024 * 1024,
  /**
   * Planned weight of one sprite: the characters of its nodes' HTML and component definitions. A sprite's documents
   * load on one thread, so megabyte documents (a playable prototype carrying its app as data) each get a sprite
   * nearly to themselves; packed five to a sprite, production timed them out at `spriteMs` on every turn.
   */
  chars: 6_000_000,
  /** A node still loading after this renders on its own, so one slow image cannot hold the whole sprite. */
  loadMs: 8000,
  /** Characters sent to the page in one message. Bounds the Worker memory a sprite's documents take in transit. */
  batchChars: 2_000_000,
  /** Shared content at least this long travels once per sprite; anything shorter stays in each document. */
  partChars: 1024,
  /** `atlas`: lossless captures of bands of the sprite, cropped in the page. `clips`: one WebP capture per node. */
  capture: "atlas" as "atlas" | "clips",
  /**
   * Captured pixels per lossless band. A band travels to the Worker and back as base64 PNG: UI compresses to about
   * 0.1 byte per pixel, but photographs can approach 3, so this bounds Worker memory and keeps a band well inside one WebSocket message. A node larger than this on its
   * own is captured directly as WebP.
   */
  bandPixels: 4 * 1024 * 1024,
  /** Encode the lossless atlas for speed rather than size; it only travels to the page that crops it. */
  fastAtlas: true,
};

/** Smallest offset step whose scaled size is a whole pixel, so a node's crop starts on the pixel a lone capture starts on. */
export function alignment(width: number) {
  const w = roundWidth(width);
  if (w <= 1280) return 1;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  return w / gcd(w, 1280);
}

const FONT_MARK = "/*sharpner-sprite-fonts*/";
const TOKEN_STYLE = `<style type="text/tailwindcss">`;
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{position:absolute;left:0;top:0;border:0;display:block}</style></head><body></body></html>`;

const roundWidth = (width: number) => Math.max(1, Math.round(width));
const estimate = (job: Pick<SpriteJob, "width" | "height" | "measuredHeight">) =>
  roundWidth(job.width) * Math.min(MAX_HEIGHT, Math.max(1, Math.round(job.height ?? job.measuredHeight ?? AUTO_VIEWPORT)));

/**
 * Splits jobs, in order, into at most `parts` sprites when they fit, so every browser tab gets a share. Each sprite
 * holds at most `limits.nodes` nodes, `limits.pixels` of planned area and `limits.chars` of planned weight; the
 * first jobs land in the first sprites.
 */
export function planSprites<T extends Pick<SpriteJob, "width" | "height" | "measuredHeight" | "weight">>(jobs: T[], parts: number, limits: Pick<typeof SPRITE_LIMITS, "nodes" | "pixels"> & Partial<Pick<typeof SPRITE_LIMITS, "chars">> = SPRITE_LIMITS): T[][] {
  if (!jobs.length) return [];
  const target = Math.min(limits.nodes, Math.max(1, Math.ceil(jobs.length / Math.max(1, parts))));
  // A sprite is captured at one scale, so frames wider than the sharp tier group by width; the rest share scale 1.
  const groups = new Map<number, T[]>();
  for (const job of jobs) {
    const key = hiScale(roundWidth(job.width));
    groups.set(key, [...groups.get(key) ?? [], job]);
  }
  const sprites: T[][] = [];
  for (const group of groups.values()) {
    let current: T[] = [], pixels = 0, chars = 0;
    for (const job of group) {
      const cost = estimate(job), weight = job.weight ?? 0;
      if (current.length && (current.length >= target || pixels + cost > limits.pixels || chars + weight > (limits.chars ?? Infinity))) {
        sprites.push(current);
        current = []; pixels = 0; chars = 0;
      }
      current.push(job); pixels += cost; chars += weight;
    }
    sprites.push(current);
  }
  return sprites;
}

/** The first Tailwind pass: each distinct Tailwind source compiles once, with the classes of every node that shares it. */
async function seedTailwind(jobs: SpriteJob[], base: string, designs: RenderDesign[]) {
  const seeds = jobs.map((job, i) => seedInput(job.html, base, designs[i]!));
  const seedCss = new Map<string, Promise<string>>();
  for (const source of new Set(seeds.map((s) => s.cssSource))) {
    seedCss.set(source, tailwindCss(source, [...new Set(seeds.filter((s) => s.cssSource === source).flatMap((s) => s.candidates))]));
  }
  return Promise.all(seeds.map((s) => seedCss.get(s.cssSource)!));
}

/** A component definition as a document's script holds it (see `componentScript`), made once per component. */
const definitions = new WeakMap<object, string>();
function definition(component: { html: string }) {
  let text = definitions.get(component);
  if (text === undefined) definitions.set(component, text = JSON.stringify(component.html).replace(/</g, "\\u003c"));
  return text;
}

/**
 * The long content a document is likely to share with others in its sprite, in the order it appears: the compiled
 * CSS, the token sheet and each component definition. A guess that is wrong costs nothing but its own search:
 * a part is only taken out of a document it is found in.
 */
function sharedParts(doc: string, css: string, design: RenderDesign): { key: object | string; text: string }[] {
  const compiled = css.replace(/<\//g, "<\\/");
  const from = doc.indexOf(TOKEN_STYLE), to = from < 0 ? -1 : doc.indexOf("</style>", from);
  const tokens = to < 0 ? "" : doc.slice(from + TOKEN_STYLE.length, to);
  return [{ key: compiled, text: compiled }, { key: tokens, text: tokens }, ...design.components.map((c) => ({ key: c, text: definition(c) }))];
}

type Loaded = { css: string; classes: string[] } | null;
type Placed = { i: number; x: number; y: number; height: number; measured: number };
type Layout = { placed: Placed[]; fallback: number[]; width: number; height: number };

/** Renders every job it can into one page and returns their captures; the rest are listed for a single render. */
export async function renderSprite(page: BrowserPage, jobs: SpriteJob[], base: string, design: RenderDesign, limits = SPRITE_LIMITS): Promise<SpriteResult> {
  const captured = new Map<string, SpriteCapture>();
  const phases: SpritePhases = { seed: 0, load: 0, settle: 0, capture: 0, encode: 0, pageLoad: 0, sentKB: 0 };
  if (!jobs.length) return { captured, fallback: [], phases };
  let mark = Date.now();
  const lap = (phase: keyof SpritePhases) => { const now = Date.now(); phases[phase] += now - mark; mark = now; };
  const designs = jobs.map((job) => documentDesign(job.html, design));
  const seeded = await seedTailwind(jobs, base, designs);
  const sizes = jobs.map((job) => ({ w: roundWidth(job.width), h: Math.round(job.height ?? AUTO_VIEWPORT) }));
  // The Worker side: the first Tailwind pass.
  lap("seed");

  await page.goto("about:blank");
  await page.setContent(SHELL, { waitUntil: "load", timeout: 5000 });
  // Only the font subsets these documents' characters need travel to the page. Text a script writes need not be in
  // its source, so documents with authored scripts keep every subset.
  const scripted = jobs.some((job) => runsScripts(job.html, design));
  const points = design.fonts && !scripted ? new Set<number>() : null;
  // Each document repeats its tokens, compiled CSS and component definitions, which can be megabytes, so a sprite's
  // documents together can pass the Worker's memory limit. The Worker builds them one at a time and sends each
  // distinct part once, with a mark in every document it belongs to; the page puts them back. Messages are bounded,
  // so the Worker never holds a whole sprite's documents, or one message carrying them.
  const open = `@@sharpner-part-${crypto.randomUUID()}-`, close = "@@";
  const partIndex = new Map<object | string, number>();
  const scan = (text: string) => { if (points) for (const char of text) points.add(char.codePointAt(0)!); };
  let batch = { parts: [] as string[], docs: [] as string[] }, batchChars = 0, sent = 0;
  const flush = async () => {
    if (!batchChars) return;
    await page.evaluate((received: { parts: string[]; docs: string[] }) => {
      const w = window as unknown as { spriteParts?: string[]; spriteDocs?: string[] };
      (w.spriteParts ??= []).push(...received.parts);
      (w.spriteDocs ??= []).push(...received.docs);
    }, batch);
    batch = { parts: [], docs: [] }; batchChars = 0;
  };
  const queue = async (list: "parts" | "docs", text: string) => {
    if (batchChars && batchChars + text.length > limits.batchChars) await flush();
    batch[list].push(text); batchChars += text.length; sent += text.length;
  };
  for (const [i, job] of jobs.entries()) {
    const doc = frameDocument(job.html, { base, design: designs[i], compiledTailwind: true, tailwindCss: seeded[i], fontCss: design.fonts ? FONT_MARK : undefined });
    // Joined, not concatenated: a slice keeps the whole document it was cut from alive.
    const pieces: string[] = [];
    let at = 0;
    for (const part of sharedParts(doc, seeded[i]!, designs[i]!)) {
      if (part.text.length < limits.partChars) continue;
      const found = doc.indexOf(part.text, at);
      if (found < 0) continue;
      let n = partIndex.get(part.key);
      if (n === undefined) {
        // A part cut from this document is copied, so the index does not keep the whole document for the sprite.
        const text = typeof part.key === "string" ? part.text.split("").join("") : part.text;
        partIndex.set(typeof part.key === "string" ? text : part.key, n = partIndex.size);
        scan(text);
        await queue("parts", text);
      }
      const before = doc.slice(at, found);
      scan(before);
      pieces.push(before, open, String(n), close);
      at = found + part.text.length;
    }
    const rest = doc.slice(at);
    scan(rest);
    pieces.push(rest);
    await queue("docs", pieces.join(""));
  }
  await flush();
  const fonts = points ? pruneFontFaces(design.fonts!, String.fromCodePoint(...points)) : design.fonts ?? "";
  phases.sentKB += Math.round((sent + fonts.length) / 1024);
  // As a single render does, a document with authored scripts gets its allowance after load; the frames load together.
  const settle = jobs.map((job, i) => runsScripts(job.html, designs[i]!) ? SCRIPT_SETTLE_MS : 0);
  const { frames: loaded, ms: pageMs } = await page.evaluate(async ({ sizes, settle, fonts, mark, open, close, timeoutMs }) => {
    const started = performance.now();
    const w = window as unknown as { spriteParts?: string[]; spriteDocs?: string[] };
    const parts = w.spriteParts ?? [];
    // Each document whole again: every mark replaced by the part it stands for. The marks hold no pattern syntax.
    const marks = new RegExp(`${open}(\\d+)${close}`, "g");
    const docs = (w.spriteDocs ?? []).map((doc) => doc.replace(marks, (_, n: string) => parts[Number(n)]!));
    delete w.spriteParts; delete w.spriteDocs;
    // Fonts arrive once as data URLs and become blob URLs every frame shares, instead of megabytes per document.
    const fontCss = fonts ? fonts.replace(/url\(data:([^;,)]+);base64,([^)]+)\)/g, (_: string, type: string, data: string) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return `url(${URL.createObjectURL(new Blob([bytes], { type }))})`;
    }) : "";
    const frames = await Promise.all(docs.map((doc, i) => new Promise<{ css: string; classes: string[] } | null>((resolve) => {
      const frame = document.createElement("iframe");
      frame.dataset.i = String(i);
      frame.style.width = `${sizes[i]!.w}px`;
      frame.style.height = `${sizes[i]!.h}px`;
      const timer = setTimeout(() => { frame.remove(); resolve(null); }, timeoutMs);
      frame.onload = async () => {
        clearTimeout(timer);
        if (settle[i]) await new Promise((wait) => setTimeout(wait, settle[i]));
        const d = frame.contentDocument;
        if (!d?.body) { frame.remove(); resolve(null); return; }
        // Component expansion has finished parsing. Read actual classes, as a single render does.
        resolve({
          css: [...d.querySelectorAll('style[type="text/tailwindcss"]')].map((style) => style.textContent).join("\n"),
          classes: [...new Set([...d.querySelectorAll("[class]")].flatMap((el) => [...el.classList]))],
        });
      };
      // srcdoc before insertion: the frame navigates straight to it, with one load event.
      frame.srcdoc = fontCss ? doc.split(mark).join(fontCss) : doc;
      document.body.appendChild(frame);
    })));
    return { frames, ms: Math.round(performance.now() - started) };
  }, { sizes, settle, fonts, mark: FONT_MARK, open, close, timeoutMs: limits.loadMs }) as { frames: Loaded[]; ms: number };
  phases.pageLoad += pageMs;

  lap("load");
  // Second Tailwind pass over the classes the documents actually hold, once per distinct authored stylesheet.
  const compiled = new Map<string, Promise<string>>();
  for (const css of new Set(loaded.flatMap((l) => l ? [l.css] : []))) {
    compiled.set(css, tailwindCss(css, [...new Set(loaded.flatMap((l) => l?.css === css ? l.classes : []))]));
  }
  const nodes = await Promise.all(loaded.map(async (l, i) => {
    if (!l) return null;
    const css = await compiled.get(l.css)!;
    return { i, css: css === seeded[i] ? null : css, auto: jobs[i]!.height == null, fixed: jobs[i]!.height, width: sizes[i]!.w, frameHeight: sizes[i]!.h };
  }));

  const layout = await page.evaluate(async ({ nodes, max, autoHeight, passes, limits, grid }) => {
    const live = nodes.filter((n): n is NonNullable<typeof n> => !!n && !!document.querySelector(`iframe[data-i="${n.i}"]`));
    const frames = live.map((n) => document.querySelector<HTMLIFrameElement>(`iframe[data-i="${n.i}"]`)!);
    const measure = (frame: HTMLIFrameElement) => Math.ceil(frame.contentDocument!.body.getBoundingClientRect().height);
    // As a single render: fonts always; CSS images too once the second pass changed the stylesheet.
    const first = await Promise.all(live.map(async (n, k) => {
      const d = frames[k]!.contentDocument!;
      if (n.css === null) {
        d.body.getBoundingClientRect();
        await d.fonts.ready;
        return measure(frames[k]!);
      }
      d.querySelector("style[data-sharpner-css]")!.textContent = n.css;
      d.body.getBoundingClientRect();
      const view = d.defaultView!;
      const urls = new Set<string>();
      for (const element of [d.body, ...d.body.querySelectorAll("*")]) {
        for (const pseudo of [null, "::before", "::after"]) {
          const style = view.getComputedStyle(element, pseudo);
          for (const value of [style.backgroundImage, style.maskImage, style.listStyleImage]) {
            for (const match of value.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]!);
          }
        }
      }
      await Promise.all([d.fonts.ready, ...[...urls].map((url) => new Promise<void>((resolve) => {
        const image = new view.Image(); image.onload = image.onerror = () => resolve(); image.src = url;
      }))]);
      return measure(frames[k]!);
    }));
    const placed: { i: number; x: number; y: number; height: number; measured: number }[] = [];
    const fallback = nodes.flatMap((n, i) => n && live.includes(n) ? [] : [i]);
    let x = 0, y = 0, row = 0, width = 0;
    live.forEach((n, k) => {
      const frame = frames[k]!;
      let measured = first[k]!, frameHeight = n.frameHeight;
      if (n.auto) {
        // Fit the frame to its content until the content stops changing with it, as a single render fits its viewport.
        let settled = false;
        for (let pass = 0; pass < passes && !settled; pass++) {
          const height = Math.min(max, Math.max(1, measured));
          if (frameHeight === height) { settled = true; break; }
          frame.style.height = `${height}px`; frameHeight = height;
          const next = measure(frame);
          settled = next === measured;
          measured = next;
        }
        if (!settled) { frame.style.height = `${autoHeight}px`; frameHeight = autoHeight; measured = measure(frame); }
      }
      const height = Math.min(max, Math.max(1, Math.round(n.fixed ?? measured)));
      // Content that grows with its frame keeps its first layout but is captured taller than that layout; a frame
      // cannot show content past its own edge, so it renders on its own page.
      // A frame that leaves the sprite also leaves the page: its pixels would show through the frames placed over it.
      if (n.auto && frameHeight !== height) { frame.remove(); fallback.push(n.i); return; }
      if (x > 0 && x + n.width > limits.width) { y += row; x = 0; row = 0; }
      if (y + frameHeight > limits.height) { frame.remove(); fallback.push(n.i); return; }
      frame.style.left = `${x}px`; frame.style.top = `${y}px`;
      placed.push({ i: n.i, x, y, height, measured });
      const up = (v: number) => Math.ceil(v / grid) * grid;
      x = up(x + n.width); row = Math.max(row, up(frameHeight)); width = Math.max(width, x);
    });
    return { placed, fallback, width, height: y + row };
  }, { nodes, max: MAX_HEIGHT, autoHeight: AUTO_VIEWPORT, passes: FIT_PASSES, limits: { width: limits.width, height: limits.height }, grid: alignment(sizes[0]!.w) }) as Layout;

  lap("settle");
  if (layout.placed.length) {
    await page.setViewport({ width: Math.max(1, layout.width), height: Math.max(1, layout.height) });
    const scale = hiScale(sizes[layout.placed[0]!.i]!.w);
    const rects = layout.placed.map((p) => {
      const w = sizes[p.i]!.w;
      // The size a capture of this node alone has: its rectangle at its scale.
      return { x: Math.round(p.x * scale), y: Math.round(p.y * scale), w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(p.height * scale)), lo: w > 256 };
    });
    // Rows of the layout, top to bottom, grouped into bands of at most `bandPixels` captured pixels.
    const rows = [...new Set(layout.placed.map((p) => p.y))].sort((a, b) => a - b);
    const area = (top: number, bottom: number) => Math.round(layout.width * scale) * Math.round((bottom - top) * scale);
    const direct = new Set<number>();
    const bands: { top: number; bottom: number; members: number[] }[] = [];
    if (limits.capture === "atlas") {
      for (const y of rows) {
        const members = layout.placed.flatMap((p, k) => p.y === y ? [k] : []);
        // A node too large for a band of its own is captured directly.
        for (const k of members) if (rects[k]!.w * rects[k]!.h > limits.bandPixels) direct.add(k);
        const kept = members.filter((k) => !direct.has(k));
        if (!kept.length) continue;
        const bottom = Math.max(...kept.map((k) => layout.placed[k]!.y + layout.placed[k]!.height));
        const band = bands.at(-1);
        if (band && area(band.top, bottom) <= limits.bandPixels) { band.bottom = bottom; band.members.push(...kept); }
        else if (area(y, bottom) <= limits.bandPixels) bands.push({ top: y, bottom, members: kept });
        else for (const k of kept) direct.add(k);
      }
    } else layout.placed.forEach((_, k) => direct.add(k));
    const encoded: ({ hi: string; lo: string | null } | undefined)[] = new Array(layout.placed.length);
    for (const band of bands) {
      // One lossless capture of the band at the sprite's scale; the page crops and encodes each node. Canvas WebP
      // at 0.8 is the same encoder and setting as a WebP capture at quality 80, so the bytes match.
      const atlas = await page.screenshot({ type: "png", encoding: "base64", clip: { x: 0, y: band.top, width: layout.width, height: band.bottom - band.top, scale }, captureBeyondViewport: true, optimizeForSpeed: limits.fastAtlas }) as unknown as string;
      lap("capture");
      const top = Math.round(band.top * scale);
      const out = await page.evaluate(async ({ atlas, rects }) => {
        const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
          // A load event, not decode(): decode() can wait indefinitely for a rendering update in a background tab.
          const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Sprite decode failed")); image.src = src;
        });
        const sheet = await load(`data:image/png;base64,${atlas}`);
        const result: { hi: string; lo: string | null }[] = [];
        for (const r of rects) {
          const canvas = document.createElement("canvas");
          canvas.width = r.w; canvas.height = r.h;
          canvas.getContext("2d")!.drawImage(sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          const hi = canvas.toDataURL("image/webp", 0.8);
          let lo: string | null = null;
          if (r.lo) {
            // Overview pixels resample the decoded sharp WebP, as a single render does.
            const image = await load(hi);
            const small = document.createElement("canvas");
            small.width = 256; small.height = Math.max(1, Math.round(image.naturalHeight * 256 / image.naturalWidth));
            const ctx = small.getContext("2d")!;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(image, 0, 0, small.width, small.height);
            lo = small.toDataURL("image/webp", 0.7).split(",")[1]!;
          }
          result.push({ hi: hi.split(",")[1]!, lo });
        }
        return result;
      }, { atlas, rects: band.members.map((k) => ({ ...rects[k]!, y: rects[k]!.y - top })) }) as { hi: string; lo: string | null }[];
      band.members.forEach((k, n) => { encoded[k] = out[n]; });
      lap("encode");
    }
    if (direct.size) {
      const order = [...direct];
      const his: string[] = [];
      for (const k of order) {
        const p = layout.placed[k]!, width = sizes[p.i]!.w;
        his.push(bytesToBase64(await capture(page, width, p.height, { type: "webp", scale: hiScale(width), x: p.x, y: p.y })));
      }
      lap("capture");
      const los = await page.evaluate(async (items: { data: string; lo: boolean }[]) => Promise.all(items.map(async ({ data, lo }) => {
        if (!lo) return null;
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
      })), his.map((data, n) => ({ data, lo: rects[order[n]!]!.lo }))) as (string | null)[];
      order.forEach((k, n) => { encoded[k] = { hi: his[n]!, lo: los[n]! }; });
      lap("encode");
    }
    const bytes = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    layout.placed.forEach((p, k) => {
      const hi = bytes(encoded[k]!.hi);
      captured.set(jobs[p.i]!.id, { width: sizes[p.i]!.w, measured: p.measured, height: p.height, hi, lo: encoded[k]!.lo ? bytes(encoded[k]!.lo!) : hi });
    });
  }
  return { captured, fallback: layout.fallback.map((i) => jobs[i]!.id), phases };
}
