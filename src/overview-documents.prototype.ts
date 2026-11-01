// THROWAWAY: normal browser documents with bounded residency; no HTML/CSS viewport translation.
import { frameDocument, type ComponentDef, type DesignSystem } from "../shared/types";
import { frameThemeReply, type FrameThemeChannel } from "../shared/themes";

export type OverviewDocumentNode = {
  id: string; source: string; width: number; height: number | null; x: number; y: number;
  theme?: string | null; measuredHeight?: number | null;
};
type Camera = { x: number; y: number; z: number };
type Size = { w: number; h: number };
export type OverviewDocumentSample = {
  height: number; domNodes: number; classes: string[]; compatMode: string; fonts: string[];
  check: { bodyBackground: string; rootBackground: string; rootFontFamily: string; rootFontSize: string; fontFamily: string; fontSize: string; lineHeight: string };
  landmarks: { selector: string; x: number; y: number; w: number; h: number; fontFamily: string; fontSize: string; lineHeight: string }[];
};
export type OverviewDocumentsProgress = {
  generation: number; theme: string | null; ms: number; resident: number; peakResident: number;
  admitted: number; current: number; visible: number; coverage: number; currentArea: number; totalArea: number;
  pending: number; created: number; evicted: number; unsupportedCount: number; failed: number;
  activeFresh: number; activeThemes: number; peakActiveFresh: number; peakActiveThemes: number;
};
export type OverviewDocumentsProbe = OverviewDocumentsProgress & {
  sourceBytes: number; superseded?: boolean;
  unsupported: { id: string; reasons: string[] }[];
  nodes: { id: string; currentTheme: string | null; height: number; ready: boolean; current: boolean;
    generation: number; admitted: boolean; authoredTailwind: boolean; components: number; canonicalRefresh: boolean;
    refreshFallback: string[]; sample?: OverviewDocumentSample; error?: string }[];
  jobs: { id: string; generation: number; kind: "create" | "retheme"; ms: number; outcome: string }[];
};
export type OverviewDocumentsOptions = {
  nodes: OverviewDocumentNode[]; design: DesignSystem; cssUrl: string; base: string; theme?: string | null;
  concurrency?: number; themeConcurrency?: number; residentLimit?: number; bootstrapUrl?: string; componentRefresh?: boolean;
  onProgress?: (progress: OverviewDocumentsProgress) => void;
};
type Layer = {
  frame: HTMLIFrameElement; channel: FrameThemeChannel; theme: string | null;
  ready: boolean; tainted: boolean; generation: number; sample?: OverviewDocumentSample;
  receive?: (event: MessageEvent) => void;
};
type Entry = {
  node: OverviewDocumentNode; design: DesignSystem; structural: Set<string>; reasons: string[];
  canonicalRefresh: boolean; refreshFallback: string[];
  authoredTailwind: boolean; shown?: Layer; pending?: Layer; failed: number; error?: string;
};
type Job = { generation: number; abort: AbortController; kind: "create" | "retheme" };
type Run = { generation: number; started: number; promise: Promise<OverviewDocumentsProbe>; resolve: (probe: OverviewDocumentsProbe) => void; done: boolean };

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const quote = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const tags = (html: string) => [...html.matchAll(/<\s*(x-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gi)].map(match => match[1]!.toLowerCase());

/** Literal closure includes every definition of a referenced tag, so nested theme contexts remain valid. */
function componentClosure(html: string, components: ComponentDef[]) {
  const needed = new Set(tags(html));
  for (let grew = true; grew;) {
    grew = false;
    for (const definition of components) if (needed.has(definition.tag)) {
      for (const tag of tags(definition.html)) if (!needed.has(tag)) { needed.add(tag); grew = true; }
    }
  }
  return components.filter(definition => needed.has(definition.tag));
}

/** Stock expansion can observe an already-expanded slotted child. Do not change that
 * initial output by enabling raw-slot refresh on authored nested component instances. */
function nestedAuthoredComponents(html: string, components: ComponentDef[]) {
  const registered = new Set(components.map(definition => definition.tag.toLowerCase()));
  if (!registered.size) return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  const visit = (root: { readonly children: HTMLCollection }, withinComponent = false): boolean => {
    for (const child of root.children) {
      const component = registered.has(child.localName);
      if (withinComponent && component) return true;
      if (visit(child, withinComponent || component)) return true;
      // Include inert nested template content conservatively; no custom elements upgrade here.
      if (child instanceof HTMLTemplateElement && visit(child.content, withinComponent || component)) return true;
    }
    return false;
  };
  return visit(template.content);
}

function unsupportedMarkup(html: string): string[] {
  const reasons = new Set<string>();
  if (/<\s*script\b/i.test(html)) reasons.add("authored-script");
  if (/<\s*(?:iframe|frame|object|embed|applet|video|audio|canvas)\b/i.test(html)) reasons.add("active-or-scripted-content");
  if (/<\s*(?:animate|animateTransform|animateMotion|set|marquee)\b/i.test(html)) reasons.add("uncontrolled-native-motion");
  if (/<meta\b[^>]*\bhttp-equiv\b/i.test(html)) reasons.add("authored-http-equiv");
  if (/\bautofocus(?:\s|=|>)/i.test(html)) reasons.add("automatic-focus");
  // Preserve user-triggered attributes, including selectors depending on them. CSP blocks their execution.
  for (const match of html.matchAll(/\b(on[\w:-]+)\s*=/gi)) {
    if (!/^on(?:click|dblclick|auxclick|contextmenu|mouse\w*|pointer\w*|touch\w*|key\w*|input|change|submit|reset|select|copy|cut|paste|drag\w*|drop)$/i.test(match[1]!)) reasons.add("automatic-event-handler");
  }
  return [...reasons];
}

/** Stringified trusted runtime; reads the actual expanded document after fonts/images and paint opportunities. */
function documentProbe(token: string, initialGeneration: number) {
  let serial = 0;
  const sample = async (generation: number) => {
    const expected = ++serial;
    const deadline = <T>(promise: Promise<T>, ms: number, label: string) => new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(label)), ms);
      promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
    });
    try {
      if (![...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(link => link.sheet)) throw new Error("stylesheet-not-loaded");
      document.body.getBoundingClientRect();
      await deadline(document.fonts.ready, 6000, "font-deadline");
      if ([...document.fonts].some(face => face.status === "loading" || face.status === "error")) throw new Error("font-not-ready");
      await deadline(Promise.all([...document.images].map(image => image.complete ? (image.naturalWidth ? Promise.resolve() : Promise.reject(new Error("image-failed"))) : new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true }); image.addEventListener("error", () => reject(new Error("image-failed")), { once: true });
      }))), 5000, "image-deadline");
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (expected !== serial) return;
      const elements = [...document.querySelectorAll("*")];
      if (elements.length > 100_000) throw new Error("expanded-dom-budget");
      const classes = [...new Set(elements.flatMap(element => [...element.classList]))].slice(0, 20_000);
      const landmarks: OverviewDocumentSample["landmarks"] = [];
      for (const selector of ["main", "h1", "button", "input", ".ov-card", "table", ".ov-chart"]) {
        const element = document.querySelector(selector); if (!element) continue;
        const bounds = element.getBoundingClientRect(), css = getComputedStyle(element);
        landmarks.push({ selector, x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height, fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight });
      }
      const body = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
      const value: OverviewDocumentSample = {
        height: Math.ceil(document.body.getBoundingClientRect().height), domNodes: elements.length, classes, compatMode: document.compatMode,
        fonts: [...new Set([...document.fonts].filter(face => face.status === "loaded").map(face => face.family))],
        check: { bodyBackground: body.backgroundColor, rootBackground: root.backgroundColor, rootFontFamily: root.fontFamily, rootFontSize: root.fontSize, fontFamily: body.fontFamily, fontSize: body.fontSize, lineHeight: body.lineHeight }, landmarks,
      };
      parent.postMessage({ type: "overview-document-sample", token, generation, value }, "*");
    } catch (error) { if (expected === serial) parent.postMessage({ type: "overview-document-sample", token, generation, error: String(error) }, "*"); }
  };
  addEventListener("message", event => {
    if (event.source === parent && event.data?.type === "overview-document-inspect" && event.data.token === token && Number.isSafeInteger(event.data.generation)) void sample(event.data.generation);
  });
  if (document.readyState === "complete") void sample(initialGeneration);
  else addEventListener("load", () => void sample(initialGeneration), { once: true });
}

/** No source edits, no uploads and no server browser. Missing/unsupported documents leave the parent's raster visible. */
export function createDocumentOverview(options: OverviewDocumentsOptions) {
  const base = new URL(options.base), css = new URL(options.cssUrl, base);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Document overview needs an HTTP base");
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
  const themeConcurrency = Math.max(1, Math.min(64, Math.floor(options.themeConcurrency ?? 32)));
  const residentLimit = Math.max(1, Math.min(300, Math.floor(options.residentLimit ?? 40)));
  const ids = new Set<string>();
  const sourceBytes = options.nodes.reduce((sum, node) => sum + new TextEncoder().encode(node.source).byteLength, 0)
    + options.design.components.reduce((sum, definition) => sum + new TextEncoder().encode(definition.html).byteLength, 0);
  if (sourceBytes > MAX_SOURCE_BYTES) throw new Error("Document overview source budget (32 MiB)");
  const entries: Entry[] = options.nodes.map(node => {
    if (ids.has(node.id)) throw new Error("Document overview requires unique node IDs"); ids.add(node.id);
    const components = componentClosure(node.source, options.design.components), markup = [node.source, ...components.map(definition => definition.html)].join("\n");
    const structural = new Set(components.flatMap(definition => definition.theme == null ? [] : [definition.theme]));
    const nestedSlots = !!options.componentRefresh && structural.size > 0 && nestedAuthoredComponents(node.source, components);
    const reasons = unsupportedMarkup(markup);
    if (![node.width, node.x, node.y].every(Number.isFinite) || node.width <= 0 || node.width > 4000 || node.height !== null && (!Number.isFinite(node.height) || node.height < 1 || node.height > 8000)) reasons.push("invalid-geometry");
    return { node, design: { tokens: options.design.tokens, components }, structural, reasons,
      canonicalRefresh: !!options.componentRefresh && !nestedSlots, refreshFallback: nestedSlots ? ["nested-authored-component-slots"] : [],
      authoredTailwind: /<style\b[^>]*type\s*=\s*["']text\/tailwindcss["']/i.test(node.source), failed: 0 };
  });
  const element = document.createElement("div"), world = document.createElement("div");
  element.dataset.overviewDocuments = "true";
  element.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
  world.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;";
  element.appendChild(world);
  let camera: Camera = { x: 0, y: 0, z: 1 }, size: Size = { w: innerWidth, h: innerHeight }, theme = options.theme ?? null;
  let generation = 0, disposed = false, activeFresh = 0, activeThemes = 0, peakActiveFresh = 0, peakActiveThemes = 0, created = 0, evicted = 0, alive = 0, peakResident = 0, scheduled = 0, progressFrame = 0;
  let desired = new Set<string>();
  const active = new Map<string, Job>(), windows = new Map<MessageEventSource, Layer>();
  const jobs: OverviewDocumentsProbe["jobs"] = [];
  const effective = (entry: Entry) => entry.node.theme ?? theme;
  const current = (entry: Entry) => !!entry.shown?.ready && !entry.shown.tainted && entry.shown.theme === effective(entry);
  const reusable = (entry: Entry) => {
    const old = entry.shown, next = effective(entry);
    if (!old?.ready || old.tainted) return false;
    return entry.canonicalRefresh || !(entry.structural.has(old.theme ?? "") || entry.structural.has(next ?? "") || entry.structural.size > 0 && (old.theme === null || next === null));
  };
  const area = (entry: Entry) => {
    const node = entry.node, height = node.height ?? entry.shown?.sample?.height ?? node.measuredHeight ?? 1000;
    const x = node.x * camera.z + camera.x, y = node.y * camera.z + camera.y, w = node.width * camera.z, h = height * camera.z;
    return Math.max(0, Math.min(size.w, x + w) - Math.max(0, x)) * Math.max(0, Math.min(size.h, y + h) - Math.max(0, y));
  };
  const priority = (entry: Entry) => {
    const node = entry.node, height = node.height ?? entry.shown?.sample?.height ?? node.measuredHeight ?? 1000;
    return area(entry) * 1e6 - Math.hypot((node.x + node.width / 2) * camera.z + camera.x - size.w / 2, (node.y + height / 2) * camera.z + camera.y - size.h / 2);
  };
  let run: Run;
  const progress = (): OverviewDocumentsProgress => {
    let totalArea = 0, currentArea = 0, visible = 0;
    for (const entry of entries) { const pixels = area(entry); totalArea += pixels; if (pixels) visible++; if (current(entry)) currentArea += pixels; }
    return { generation, theme, ms: performance.now() - run.started, resident: alive, peakResident, admitted: desired.size,
      current: entries.filter(current).length, visible, coverage: totalArea ? currentArea / totalArea : 0, totalArea, currentArea,
      pending: entries.filter(entry => desired.has(entry.node.id) && !current(entry) && entry.failed !== generation).length,
      created, evicted, unsupportedCount: entries.filter(entry => entry.reasons.length).length, failed: entries.filter(entry => entry.failed === generation).length,
      activeFresh, activeThemes, peakActiveFresh, peakActiveThemes };
  };
  const inspect = (): OverviewDocumentsProbe => ({ ...progress(), sourceBytes,
    unsupported: entries.filter(entry => entry.reasons.length).map(entry => ({ id: entry.node.id, reasons: entry.reasons })),
    nodes: entries.map(entry => ({ id: entry.node.id, currentTheme: entry.shown?.theme ?? null, height: entry.shown?.sample?.height ?? entry.node.measuredHeight ?? entry.node.height ?? 1000,
      ready: !!entry.shown?.ready, current: current(entry), generation: entry.shown?.generation ?? 0, admitted: desired.has(entry.node.id), authoredTailwind: entry.authoredTailwind,
      components: entry.design.components.length, canonicalRefresh: entry.canonicalRefresh, refreshFallback: entry.refreshFallback,
      sample: entry.shown?.sample, error: entry.error })), jobs: jobs.slice(),
  });
  const publish = () => {
    if (!progressFrame && !disposed) progressFrame = requestAnimationFrame(() => { progressFrame = 0; options.onProgress?.(progress()); });
  };
  const destroy = (layer: Layer) => { windows.delete(layer.frame.contentWindow!); layer.receive = undefined; layer.frame.remove(); alive--; };
  const evict = (entry: Entry) => {
    active.get(entry.node.id)?.abort.abort();
    if (entry.pending) { destroy(entry.pending); entry.pending = undefined; }
    if (entry.shown) { destroy(entry.shown); entry.shown = undefined; evicted++; }
  };
  const receive = (event: MessageEvent) => windows.get(event.source!)?.receive?.(event);
  addEventListener("message", receive);
  const wait = <T>(layer: Layer, signal: AbortSignal, accept: (event: MessageEvent) => T | undefined) => new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); layer.receive = undefined; signal.removeEventListener("abort", aborted); };
    const aborted = () => { cleanup(); reject(new DOMException("Superseded", "AbortError")); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Document response deadline")); }, 12_000);
    layer.receive = event => { try { const value = accept(event); if (value !== undefined) { cleanup(); resolve(value); } } catch (error) { cleanup(); reject(error); } };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  const sampleMessage = (layer: Layer, expected: number, event: MessageEvent): OverviewDocumentSample | undefined => {
    const data = event.data;
    if (data?.type !== "overview-document-sample" || data.token !== layer.channel.token || data.generation !== expected) return;
    if (data.error) throw new Error(String(data.error));
    if (!data.value || !Number.isFinite(data.value.height) || data.value.height < 0 || data.value.height > 100_000 || !Array.isArray(data.value.classes)) throw new Error("Invalid document sample");
    return data.value as OverviewDocumentSample;
  };
  const create = async (entry: Entry, expected: number, signal: AbortSignal) => {
    // This capability is only valid with this document's nonce CSP and no input owner.
    // Authored user-event attributes stay present for CSS selectors but cannot execute.
    const channel: FrameThemeChannel = { token: crypto.randomUUID(), generation: 0, prototypeIdleDocument: true, ...(entry.canonicalRefresh && entry.structural.size ? { prototypeComponentRefresh: true } : {}) };
    const nonce = crypto.randomUUID(), frame = document.createElement("iframe");
    const layer: Layer = { frame, channel, theme: effective(entry), ready: false, tainted: false, generation: expected };
    entry.pending = layer; frame.sandbox.add("allow-scripts"); frame.title = `Overview document ${entry.node.id}`; frame.tabIndex = -1; frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = `position:absolute;left:${entry.node.x}px;top:${entry.node.y}px;width:${entry.node.width}px;height:${entry.node.height ?? entry.node.measuredHeight ?? 1000}px;border:0;pointer-events:none;opacity:0;`;
    const policy = `default-src 'none';script-src 'nonce-${nonce}';style-src 'unsafe-inline' https: data: ${css.origin};font-src https: data:;img-src https: data: ${base.origin};connect-src 'none';frame-src 'none';object-src 'none';worker-src 'none';media-src 'none';form-action 'none'`;
    let doc = frameDocument(entry.node.source, { base: base.href, design: entry.design, theme: layer.theme, themeChannel: channel, compiledTailwind: true, prototypeComponentRefresh: entry.canonicalRefresh && entry.structural.size > 0 });
    doc = doc.replace(/<script\b/gi, `<script nonce="${nonce}"`);
    const head = `<meta http-equiv="Content-Security-Policy" content="${quote(policy)}"><link rel="stylesheet" href="${quote(css.href)}"><style>*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}</style>`;
    doc = doc.replace(/<head\b[^>]*>/i, value => value + head);
    const script = `<script nonce="${nonce}">(${documentProbe.toString()})(${JSON.stringify(channel.token)},${expected})</script>`;
    doc = /<\/body\s*>/i.test(doc) ? doc.replace(/<\/body\s*>/i, value => script + value) : doc + script;
    const bootstrap = options.bootstrapUrl ? new URL(options.bootstrapUrl, base) : undefined;
    const bootstrapToken = bootstrap ? crypto.randomUUID() : undefined;
    if (bootstrap) bootstrap.hash = bootstrapToken!;
    let sentDocument = false;
    const result = wait(layer, signal, event => {
      if (bootstrap && !sentDocument && event.source === frame.contentWindow && event.data?.type === "overview-bootstrap-ready" && event.data.token === bootstrapToken) {
        if (!disposed && !signal.aborted && generation === expected && entry.pending === layer) {
          sentDocument = true;
          frame.contentWindow!.postMessage({ type: "overview-bootstrap", token: bootstrapToken, html: doc }, "*");
        }
        return;
      }
      return sampleMessage(layer, expected, event);
    });
    // Register the window after insertion, before assigning a navigable document.
    world.appendChild(frame); alive++; created++; peakResident = Math.max(peakResident, alive); windows.set(frame.contentWindow!, layer);
    if (bootstrap) frame.src = bootstrap.href;
    else frame.srcdoc = doc;
    layer.sample = await result;
    return layer;
  };
  const update = async (entry: Entry, expected: number, signal: AbortSignal, kind: Job["kind"]) => {
    const old = entry.shown, next = effective(entry);
    if (kind === "retheme" && old) {
      old.channel = { ...old.channel, generation: old.channel.generation + 1 }; old.ready = false;
      const was = old.theme;
      const aborted = () => { old.tainted = true; }; signal.addEventListener("abort", aborted, { once: true });
      try {
        const applied = wait(old, signal, event => { const reply = frameThemeReply(event, old.frame.contentWindow, old.channel); return reply?.type === "sharpner:frame-ready" ? "ready" : reply?.type === "sharpner:frame-reload" ? "reload" : undefined; });
        old.frame.contentWindow!.postMessage({ type: "sharpner:frame-theme", ...old.channel, theme: next }, "*");
        if (await applied === "ready") {
          const result = wait(old, signal, event => sampleMessage(old, expected, event));
          old.frame.contentWindow!.postMessage({ type: "overview-document-inspect", token: old.channel.token, generation: expected }, "*");
          const sample = await result;
          if (signal.aborted) throw new DOMException("Superseded", "AbortError");
          old.sample = sample; old.theme = next; old.generation = expected; old.ready = true;
          return { layer: old, kind: "retheme" as const };
        }
        old.theme = was; old.ready = true; old.tainted = true;
        // Return this entry to the fresh-document queue; hot command admission must not
        // create replacement documents beyond the separately bounded cold concurrency.
        return { layer: old, kind: "reload" as const };
      } finally { signal.removeEventListener("abort", aborted); }
    }
    return { layer: await create(entry, expected, signal), kind: "create" as const };
  };
  const finish = () => {
    if (run.done || [...active.values()].some(job => job.generation === generation)) return;
    if (entries.some(entry => desired.has(entry.node.id) && !current(entry) && entry.failed !== generation)) return;
    run.done = true; const probe = inspect(); run.resolve(probe); options.onProgress?.(progress());
  };
  const pump = () => {
    scheduled = 0; if (disposed) return;
    const started = performance.now();
    for (const entry of entries.filter(entry => desired.has(entry.node.id) && !current(entry) && entry.failed !== generation && !active.has(entry.node.id)).sort((a, b) => priority(b) - priority(a))) {
      if (performance.now() - started > 4) break;
      const kind: Job["kind"] = reusable(entry) ? "retheme" : "create";
      if (kind === "retheme" ? activeThemes >= themeConcurrency : activeFresh >= concurrency) continue;
      const expected = generation, abort = new AbortController(), job: Job = { generation: expected, abort, kind }, jobStarted = performance.now();
      active.set(entry.node.id, job);
      if (kind === "retheme") peakActiveThemes = Math.max(peakActiveThemes, ++activeThemes);
      else peakActiveFresh = Math.max(peakActiveFresh, ++activeFresh);
      if (entry.shown) entry.shown.frame.style.opacity = ".55";
      void update(entry, expected, abort.signal, kind).then(({ layer, kind: outcome }) => {
        if (disposed || abort.signal.aborted || generation !== expected || !desired.has(entry.node.id)) return;
        if (outcome === "reload") { jobs.push({ id: entry.node.id, generation: expected, kind, ms: performance.now() - jobStarted, outcome: "reload" }); return; }
        if (layer !== entry.shown) { if (entry.shown) destroy(entry.shown); entry.pending = undefined; entry.shown = layer; }
        layer.ready = true; layer.generation = expected; layer.frame.style.opacity = "1";
        if (entry.node.height === null) layer.frame.style.height = `${Math.max(1, layer.sample!.height)}px`;
        entry.error = undefined; jobs.push({ id: entry.node.id, generation: expected, kind: outcome, ms: performance.now() - jobStarted, outcome: "ready" });
      }).catch(error => {
        if (entry.pending && entry.pending.generation === expected) { destroy(entry.pending); entry.pending = undefined; }
        if (!abort.signal.aborted && generation === expected) { entry.failed = expected; entry.error = String(error); }
        jobs.push({ id: entry.node.id, generation: expected, kind, ms: performance.now() - jobStarted, outcome: abort.signal.aborted ? "superseded" : String(error) });
      }).finally(() => {
        if (kind === "retheme") activeThemes--; else activeFresh--;
        if (active.get(entry.node.id) === job) active.delete(entry.node.id); if (jobs.length > 1000) jobs.splice(0, jobs.length - 1000);
        publish(); schedule();
      });
    }
    finish();
    if (entries.some(entry => desired.has(entry.node.id) && !current(entry) && entry.failed !== generation && !active.has(entry.node.id) && (reusable(entry) ? activeThemes < themeConcurrency : activeFresh < concurrency))) schedule();
  };
  const schedule = () => { if (!scheduled && !disposed) scheduled = requestAnimationFrame(pump); };
  const admission = () => {
    desired = new Set(entries.filter(entry => !entry.reasons.length && area(entry) > 0).sort((a, b) => priority(b) - priority(a)).slice(0, residentLimit).map(entry => entry.node.id));
    for (const entry of entries) if (!desired.has(entry.node.id) && (entry.shown || entry.pending || active.has(entry.node.id))) evict(entry);
    publish(); schedule();
  };
  const begin = (next: string | null) => {
    if (run && !run.done) { run.done = true; run.resolve({ ...inspect(), superseded: true }); }
    generation++; theme = next;
    for (const entry of entries) {
      active.get(entry.node.id)?.abort.abort();
      if (entry.pending) { destroy(entry.pending); entry.pending = undefined; }
      if (entry.shown && current(entry)) { entry.shown.generation = generation; entry.shown.frame.style.opacity = "1"; }
      else if (entry.shown) entry.shown.frame.style.opacity = ".55";
    }
    let resolve!: Run["resolve"];
    const promise = new Promise<OverviewDocumentsProbe>(value => { resolve = value; });
    run = { generation, started: performance.now(), promise, resolve, done: false }; admission(); return promise;
  };
  const ready = begin(theme);
  return {
    element, ready,
    setTheme: (next: string | null) => disposed ? Promise.reject(new Error("Document overview disposed")) : next === theme && !run.done ? run.promise : begin(next),
    camera: (next: Camera, viewport: Size) => {
      if (disposed || ![next.x, next.y, next.z, viewport.w, viewport.h].every(Number.isFinite) || next.z <= 0) return;
      camera = next; size = viewport; world.style.transform = `matrix(${next.z},0,0,${next.z},${next.x},${next.y})`; admission();
    },
    inspect,
    dispose: () => {
      if (disposed) return; if (!run.done) { run.done = true; run.resolve({ ...inspect(), superseded: true }); }
      disposed = true; cancelAnimationFrame(scheduled); cancelAnimationFrame(progressFrame); removeEventListener("message", receive);
      for (const job of active.values()) job.abort.abort(); for (const entry of entries) evict(entry); element.remove();
    },
  };
}
