// THROWAWAY PROTOTYPE: persistent, opaque-origin HTML documents on the existing canvas.
// Question: can warmed HTML views adapt faster than server-generated overview rasters?
// Supported: declarative HTML/CSS, props/slots, nested contexts, structural component theme overrides.
// Unsupported authored JavaScript is reported to the caller rather than silently discarded.
import { componentTheme, documentThemeScript } from "../shared/themes";
import { frameDocument } from "../shared/types";
import type { PrototypeFrame, PrototypeReady, PrototypeSurface } from "./frame-surface.prototype";

type Payload = { html: string; source: string; components: PrototypeFrame["design"]["components"]; theme?: string; themeScript: string; cssImages: boolean };
type ThemeContext = { element: HTMLElement; theme: string | null; classes: string | null; style: string | null };

/** Runs only inside the opaque-origin frame. No author code is evaluated here. */
function persistentRuntime(token: string, themeOf: typeof componentTheme) {
  let current: Payload | null = null;
  let contexts: ThemeContext[] = [];
  let definitions = new WeakMap<Element, string>();
  let sequence = Promise.resolve();
  const esc = (value: string) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  const restore = () => {
    for (const context of contexts) {
      for (const [name, value] of [["data-theme", context.theme], ["class", context.classes], ["style", context.style]] as const) {
        if (value === null) context.element.removeAttribute(name);
        else context.element.setAttribute(name, value);
      }
    }
  };
  const captureContexts = () => {
    contexts = [document.documentElement, document.body, ...document.body.querySelectorAll<HTMLElement>("[data-theme],.dark,.light")]
      .map((element) => ({ element, theme: element.getAttribute("data-theme"), classes: element.getAttribute("class"), style: element.getAttribute("style") }));
  };
  const copyAttributes = (target: HTMLElement, source: HTMLElement) => {
    for (const attr of [...target.attributes]) target.removeAttribute(attr.name);
    for (const attr of [...source.attributes]) target.setAttribute(attr.name, attr.value);
  };
  const selectDefinition = (element: Element, components: Payload["components"], theme: string | undefined) => {
    const defs = components.filter((def) => def.tag === element.localName);
    const selected = element.getAttribute("data-sharpner-definition") ?? themeOf(element, theme);
    return defs.find((def) => (def.theme ?? "") === selected)?.html ?? defs.find((def) => !def.theme)?.html;
  };
  const expand = (payload: Payload) => {
    definitions = new WeakMap();
    const tags = [...new Set(payload.components.map((definition) => definition.tag))];
    // A nearest same-tag ancestor is the shared runtime's recursion guard.
    for (let changed = true; changed;) {
      changed = false;
      for (const tag of tags) for (const element of document.body.querySelectorAll<HTMLElement>(tag)) {
        if (definitions.has(element) || element.parentElement?.closest(tag)) continue;
        const html = selectDefinition(element, payload.components, payload.theme);
        if (html === undefined) { definitions.set(element, ""); continue; }
        definitions.set(element, html);
        const children = element.innerHTML;
        element.style.display = "contents";
        element.innerHTML = html.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, prop: string, fallback: string | undefined) => esc(element.hasAttribute(prop) ? element.getAttribute(prop)! : (fallback ?? "").trim()))
          .replace(/<slot\s*\/?>(\s*<\/slot>)?/gi, () => children);
        changed = true;
      }
    }
  };
  const waitImage = (image: HTMLImageElement) => image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
  const update = async (payload: Payload) => {
    const parsed = new DOMParser().parseFromString(payload.html, "text/html");
    restore();
    const headChanged = document.head.dataset.prototypeHead !== parsed.head.innerHTML;
    const headLoads: Promise<void>[] = [];
    if (headChanged) {
      const head = [...parsed.head.childNodes].map((node) => document.importNode(node, true));
      for (const node of head) if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
        headLoads.push(new Promise<void>((resolve) => { node.onload = node.onerror = () => resolve(); }));
      }
      document.head.replaceChildren(...head);
      document.head.dataset.prototypeHead = parsed.head.innerHTML;
    }
    (window as unknown as { __sharpnerTheme?: string }).__sharpnerTheme = payload.theme;
    const tags = [...new Set(payload.components.map((definition) => definition.tag))];
    const requiresStructure = !current || current.source !== payload.source || JSON.stringify(current.components) !== JSON.stringify(payload.components) ||
      [...document.body.querySelectorAll(tags.length ? tags.join(",") : "__prototype_no_components__")].some((element) =>
        definitions.has(element) && definitions.get(element) !== (selectDefinition(element, payload.components, payload.theme) ?? ""));
    if (requiresStructure) {
      copyAttributes(document.documentElement, parsed.documentElement);
      const body = document.importNode(parsed.body, true);
      document.body.replaceWith(body);
      expand(payload);
      captureContexts();
    }
    // The script is generated by the shared theme function in the trusted parent module.
    // It applies only after component expansion, exactly like frameDocument.
    if (payload.themeScript) (0, eval)(payload.themeScript);
    await Promise.all(headLoads);
    document.body.getBoundingClientRect(); // Start layout-dependent font loading in background frames.
    const cssImages: Promise<void>[] = [];
    if (payload.cssImages) {
      const urls = new Set<string>();
      for (const element of [document.body, ...document.body.querySelectorAll("*")]) {
        for (const pseudo of [null, "::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          for (const value of [style.backgroundImage, style.maskImage, style.listStyleImage]) for (const match of value.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]!);
        }
      }
      for (const url of urls) {
        const image = new Image();
        image.src = url;
        cssImages.push(waitImage(image));
      }
    }
    await Promise.all([document.fonts.ready, ...[...document.images].map(waitImage), ...cssImages]);
    document.body.getBoundingClientRect();
    current = payload;
    return Math.ceil(document.body.getBoundingClientRect().height);
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.prototypeToken !== token || event.data?.type !== "update") return;
    const { id, payload } = event.data as { id: number; payload: Payload };
    sequence = sequence.catch(() => {}).then(async () => {
      try {
        const measuredHeight = await update(payload);
        parent.postMessage({ prototypeToken: token, type: "ready", id, measuredHeight, domNodes: document.querySelectorAll("*").length }, "*");
      } catch (error) {
        parent.postMessage({ prototypeToken: token, type: "ready", id, error: String(error) }, "*");
      }
    });
  });
  const ready = () => parent.postMessage({ prototypeToken: token, type: "boot" }, "*");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
}

export function mountPersistentFrame(host: HTMLElement): PrototypeSurface {
  const iframe = document.createElement("iframe");
  const token = crypto.randomUUID();
  iframe.sandbox.add("allow-scripts");
  iframe.title = "Persistent HTML prototype";
  iframe.style.cssText = "display:block;border:0;pointer-events:none;background:transparent";
  const pending = new Map<number, { resolve(value: PrototypeReady): void; timer: ReturnType<typeof setTimeout>; height: number | null }>();
  let disposed = false, id = 0;
  let boot!: (ready: boolean) => void;
  const booted = new Promise<boolean>((resolve) => { boot = resolve; });
  const bootTimer = setTimeout(() => boot(false), 8000);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.data?.prototypeToken !== token) return;
    if (event.data.type === "boot") { clearTimeout(bootTimer); boot(true); return; }
    if (event.data.type !== "ready") return;
    const request = pending.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(event.data.id);
    if (!event.data.error) iframe.style.height = `${request.height ?? event.data.measuredHeight}px`;
    request.resolve({ measuredHeight: event.data.measuredHeight ?? 0, domNodes: event.data.domNodes ?? 0, supported: !event.data.error, ...(event.data.error ? { reason: event.data.error } : {}) });
  };
  addEventListener("message", onMessage);
  const runtime = `(${persistentRuntime.toString()})(${JSON.stringify(token)}, ${componentTheme.toString()})`;
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><script>${runtime.replace(/<\//g, "<\\/")}</script></body></html>`;
  host.replaceChildren(iframe);
  return {
    async update(frame) {
      const material = [frame.html, frame.design.tokens, ...frame.design.components.map((definition) => definition.html)].join("\n");
      const unsupported = /<script\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']?\s*javascript:|<(?:iframe|object|embed)\b|:defined\b/i.test(material);
      if (unsupported) return { measuredHeight: frame.height ?? 0, supported: false, reason: "Persistent prototype requires declarative HTML: author scripts, event handlers, nested browsing contexts and :defined selectors need the original isolated-document fallback." };
      if (/\bclass\s*=\s*["'][^"']*\{\{/.test(material)) return { measuredHeight: frame.height ?? 0, supported: false, reason: "Dynamic utility-class props require an expanded-DOM CSS compilation pass, absent from this prototype." };
      if (!await booted) return { measuredHeight: frame.height ?? 0, supported: false, reason: "Persistent runtime did not boot within eight seconds" };
      if (disposed) return { measuredHeight: 0, supported: false, reason: "Surface disposed" };
      iframe.style.width = `${frame.width}px`;
      iframe.style.height = `${frame.height ?? 800}px`;
      let html = frameDocument(frame.html, { base: location.origin, design: { ...frame.design, components: [] }, compiledTailwind: true, tailwindCss: frame.cssUrl ? "" : frame.css });
      if (frame.cssUrl) html = html.replace('<style data-sharpner-css></style>', `<link rel="stylesheet" href="${frame.cssUrl.replace(/"/g, "&quot;")}">`);
      const themeScript = documentThemeScript(frame.theme).replace(/^<script>|<\/script>$/g, "");
      const cssImages = /url\(/i.test([frame.css, material].join("\n").replace(/@font-face\s*\{[^}]*\}|@import[^;]*;/gi, ""));
      const requestId = ++id;
      return new Promise<PrototypeReady>((resolve) => {
        const timer = setTimeout(() => { pending.delete(requestId); resolve({ measuredHeight: frame.height ?? 0, supported: false, reason: "Persistent frame exceeded 12-second ready deadline" }); }, 12_000);
        pending.set(requestId, { resolve, timer, height: frame.height });
        iframe.contentWindow!.postMessage({ prototypeToken: token, type: "update", id: requestId, payload: { html, source: frame.html, components: frame.design.components, theme: frame.theme, themeScript, cssImages } satisfies Payload }, "*");
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(bootTimer); boot(false);
      removeEventListener("message", onMessage);
      for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ measuredHeight: 0, supported: false, reason: "Surface disposed" }); }
      pending.clear(); iframe.remove();
    },
  };
}
