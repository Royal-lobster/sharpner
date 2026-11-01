// THROWAWAY: one opaque preview document for a deliberately restricted declarative tier.
// This keeps the existing component expander. It is not a general HTML/CSS or script sandbox model.
import { frameDocument, type ComponentDef, type DesignSystem } from "../shared/types";

export type SharedOverviewNode = {
  id: string; source: string; width: number; height: number | null; x: number; y: number; theme?: string | null;
};
export type SharedOverviewLandmark = {
  selector: string; index: number; tag: string; x: number; y: number; w: number; h: number;
  fontFamily: string; fontSize: string; lineHeight: string;
};
export type SharedOverviewProbe = {
  generation: number; theme: string; rendered: number; unsupported: { id: string; reasons: string[] }[];
  descendantNodes: number; sourceBytes: number; initMs: number; themeMs: number; probeMs: number;
  rebuilt: number; fonts: string[]; strippedHandlers: number; superseded?: boolean; batchSize: number; renderMs: number; contained: boolean;
  contract: string[];
  nodes: { id: string; width: number; height: number; measuredHeight: number; check: { bodyBackground: string; fontFamily: string; fontSize: string; lineHeight: string }; landmarks: SharedOverviewLandmark[] }[];
};
export type SharedOverviewOptions = {
  nodes: SharedOverviewNode[]; design: DesignSystem; cssUrl: string; theme: string; base: string;
};
type SanitizedNode = SharedOverviewNode & { strippedHandlers: number };
type Camera = { x: number; y: number; z: number };

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_DOM_NODES = 75_000;
const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Conservative syntax gate; geometry and pixel comparisons must separately validate eligibility. */
function sanitizeFragment(source: string): { html: string; reasons: string[]; strippedHandlers: number } {
  const reasons = new Set<string>();
  if (/<\s*(?:!doctype|html|head|body)\b/i.test(source)) reasons.add("full-document-root");
  if (/<\s*(?:script|style|link|base|meta|iframe|frame|object|embed|canvas|video|audio|portal)\b/i.test(source)) reasons.add("active-or-document-element");
  const template = document.createElement("template");
  template.innerHTML = source;
  let strippedHandlers = 0;
  for (const element of template.content.querySelectorAll("*")) {
    if (element.hasAttribute("data-theme") || element.classList.contains("dark") || element.classList.contains("light") || element.hasAttribute("data-sharpner-definition")) reasons.add("authored-theme-context");
    if (element.hasAttribute("shadowrootmode") || element.hasAttribute("is") || element.hasAttribute("popover") || element.matches("dialog[open]")) reasons.add("custom-or-top-layer-behavior");
    if (element.hasAttribute("autofocus")) reasons.add("document-focus-state");
    if (element.hasAttribute("srcset")) reasons.add("responsive-image-source");
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      if (/^on/i.test(name)) {
        if (/^on(?:load|error|animation|transition|toggle|before)/i.test(name)) reasons.add("automatic-event-handler");
        element.removeAttribute(name); strippedHandlers++;
      } else if (/^(?:src|xlink:href)$/i.test(name) && value && !value.startsWith("data:") && !value.startsWith("#")) reasons.add("external-resource");
      else if (/^href$/i.test(name) && (/^\s*(?:javascript|vbscript):/i.test(value) || element.localName === "use" && !value.startsWith("#"))) reasons.add("active-or-external-reference");
      else if (name === "style") {
        if (/\d(?:\.\d+)?(?:[dsl]?v[whib]|vmin|vmax|cq(?:w|h|i|b|min|max))\b/i.test(value)) reasons.add("viewport-or-container-unit");
        if (/position\s*:\s*(?:fixed|sticky)/i.test(value)) reasons.add("viewport-position");
        for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/g)) {
          if (!/^(?:data:|#)/.test(match[1] ?? match[2] ?? match[3]!)) reasons.add("external-style-resource");
        }
      }
    }
  }
  return { html: template.innerHTML, reasons: [...reasons], strippedHandlers };
}

function stylesheetLimits(tokens: string): string[] {
  const reasons = new Set<string>();
  let bodyFont = false, bodyColor = false, bodyBackground = false;
  const css = tokens.replace(/@import\s+(?:url\()?\s*["']?https:\/\/fonts\.googleapis\.com\/[^;]+;/g, "");
  if (/@import\b/i.test(css)) reasons.add("unprepared-stylesheet-import");
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/g)) {
    if (!/^(?:data:|#)/.test(match[1] ?? match[2] ?? match[3]!)) reasons.add("unprepared-css-resource");
  }
  if (/\d(?:\.\d+)?(?:[dsl]?v[whib]|vmin|vmax|cq(?:w|h|i|b|min|max))\b/i.test(css)) reasons.add("viewport-or-container-css-unit");
  if (/@media[^{}]*(?:width|height|orientation|aspect-ratio)\b/i.test(css)) reasons.add("viewport-media-query");
  if (/@container\b/i.test(css)) reasons.add("container-query-scope");
  if (/position\s*:\s*(?:fixed|sticky)/i.test(css)) reasons.add("viewport-css-position");
  for (const [, selector = "", declarations = ""] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const hasHtml = /(?:^|[\s>+~,(|])html(?![\w-])/.test(selector);
    const hasBody = /(?:^|[\s>+~,(|])body(?![\w-])/.test(selector);
    const hasRoot = selector.includes(":root");
    if (/(?:^|[\s>+~,(])#[A-Za-z_][\w-]*/.test(selector)) reasons.add("stylesheet-id-selector");
    if (/\[\s*on[a-z]+\b/i.test(selector)) reasons.add("handler-dependent-selector");
    if (/\[data-theme|\.dark\b|\.light\b/.test(selector) && (hasRoot || hasHtml || hasBody)) reasons.add("document-qualified-theme-selector");
    if ((hasRoot || hasHtml) && /(?:^|;)\s*font(?:-[\w-]+)?\s*:/.test(declarations)) reasons.add("document-root-font-rule");
    if (hasBody && /(?:^|;)\s*(?:display|position|padding(?:-[\w-]+)?|transform|zoom)\s*:/.test(declarations)) reasons.add("document-body-layout-rule");
    if (selector.split(",").some(part => part.trim() === "body")) {
      bodyFont ||= /(?:^|;)\s*font(?:-family)?\s*:[^;]*var\(--font-sans\)/.test(declarations);
      bodyColor ||= /(?:^|;)\s*color\s*:\s*var\(--color-foreground\)\s*(?:;|$)/.test(declarations);
      bodyBackground ||= /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--color-background\)\s*(?:;|$)/.test(declarations);
    }
  }
  // Deliberate authoring subset: do not silently substitute token colors/fonts for unrelated body CSS.
  if (!bodyFont || !bodyColor || !bodyBackground) reasons.add("body-proxy-contract-not-declared");
  return [...reasons];
}

/** All runtime dependencies are inside this function because it is stringified into the opaque realm. */
function sharedBridge(token: string, nodes: SanitizedNode[], initialTheme: string, preUnsupported: { id: string; reasons: string[] }[], sourceBytes: number, structuralThemes: string[], maxDomNodes: number) {
  const world = document.createElement("sharpner-preview-world");
  world.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;";
  document.body.appendChild(world);
  const hosts = new Map<string, HTMLElement>();
  const counts = new Map<string, number>();
  const unsupported = new Map(preUnsupported.map(item => [item.id, item.reasons]));
  const structural = new Set(structuralThemes);
  let generation = 0, theme = initialTheme, camera = { x: 0, y: 0, z: 1 }, initMs = 0, totalNodes = 0, batchSize = 0, renderMs = 0, contained = false;
  const born = performance.now();
  (window as unknown as { __sharpnerTheme: null }).__sharpnerTheme = null;
  // Root stays on the base presentation. A Light host must not inherit another host's Dusk variables.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark", "light");
  const post = (seq: number, value: unknown, error?: string) => parent.postMessage({ type: "overview-shared-reply", token, seq, value, error }, "*");
  const effective = (node: SanitizedNode, fileTheme: string) => node.theme ?? fileTheme;
  const markUnsupported = (id: string, reason: string) => { unsupported.set(id, [...new Set([...(unsupported.get(id) ?? []), reason])]); hosts.get(id)?.remove(); hosts.delete(id); totalNodes -= counts.get(id) ?? 0; counts.delete(id); };
  const render = async (nextTheme: string, initial = false, expected = generation) => {
    let rebuilt = 0, processed = 0;const start = performance.now();
    const seenIds = new Set<string>();
    for (const node of nodes) {
      if (batchSize && processed++ && (processed - 1) % batchSize === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (expected !== generation) return rebuilt;
      if (unsupported.has(node.id)) continue;
      let host = hosts.get(node.id);
      const before = host?.dataset.theme;
      const next = effective(node, nextTheme);
      if (!host) {
        host = document.createElement("sharpner-preview-surface");
        host.setAttribute("data-shared-host", node.id); host.inert = true;
        host.style.cssText = `position:absolute;left:${node.x}px;top:${node.y}px;width:${node.width}px;${node.height === null ? "" : `height:${node.height}px;`}overflow:hidden;display:block;box-sizing:border-box;padding:0;border:0;margin:0;background:var(--color-background,transparent);color:var(--color-foreground,inherit);font-family:var(--font-sans,inherit);font-size:inherit;line-height:inherit;`;
        hosts.set(node.id, host); world.appendChild(host);
      }
      host.style.contain = contained ? "layout style paint" : "none";
      host.dataset.theme = next;
      host.classList.remove("dark", "light");
      if (next === "dark" || next === "light") host.classList.add(next);
      if (initial || before === undefined || before !== next && (structural.has(before) || structural.has(next))) {
        // Reuse frameDocument's registered component engine; fresh instances reselect their definitions.
        host.innerHTML = node.source; rebuilt++;
        const count = host.querySelectorAll("*").length + 1;
        totalNodes += count - (counts.get(node.id) ?? 0); counts.set(node.id, count);
      }
      for (const element of host.querySelectorAll<HTMLElement>("[id]")) {
        if (seenIds.has(element.id)) { markUnsupported(node.id, "duplicate-id-across-previews"); break; }
        seenIds.add(element.id);
      }
      // Check after component expansion, whose fanout is larger than the source fragment.
      if (totalNodes > maxDomNodes) markUnsupported(node.id, "expanded-dom-budget");
    }
    theme = nextTheme; renderMs = performance.now() - start; return rebuilt;
  };
  const settle = async () => {
    if (![...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].every(link => link.sheet)) throw new Error("shared-stylesheet-not-loaded");
    world.getBoundingClientRect();
    await Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("shared-font-deadline")), 5000))]);
    if ([...document.fonts].some(face => face.status === "error" || face.status === "loading")) throw new Error("shared-font-not-ready");
    await Promise.all([...world.querySelectorAll("img")].map(image => image.complete && image.naturalWidth ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error("shared-image-deadline")); }, 3000);
      image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(); };
      image.onerror = () => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error("shared-image-failed")); };
    })));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  const probe = (changedMs = 0, rebuilt = 0): SharedOverviewProbe => {
    const start = performance.now(), zoom = camera.z;
    const records: SharedOverviewProbe["nodes"] = [];
    for (const node of nodes) {
      const host = hosts.get(node.id); if (!host) continue;
      const bounds = host.getBoundingClientRect(), style = getComputedStyle(host), landmarks: SharedOverviewLandmark[] = [];
      for (const selector of ["main.ov-shell", "h1", ".ov-card", "input", "table", ".ov-chart"]) {
        [...host.querySelectorAll(selector)].slice(0, selector === ".ov-card" ? 2 : 1).forEach((element, index) => {
          const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
          landmarks.push({ selector, index, tag: element.localName, x: (rect.x - bounds.x) / zoom, y: (rect.y - bounds.y) / zoom, w: rect.width / zoom, h: rect.height / zoom, fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight });
        });
      }
      records.push({ id: node.id, width: host.offsetWidth, height: bounds.height / zoom, measuredHeight: host.scrollHeight, check: { bodyBackground: style.backgroundColor, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight }, landmarks });
    }
    return {
      generation, theme, rendered: hosts.size, unsupported: [...unsupported].map(([id, reasons]) => ({ id, reasons })),
      descendantNodes: totalNodes, sourceBytes, initMs, themeMs: changedMs, probeMs: performance.now() - start,
      rebuilt, batchSize, renderMs, contained, fonts: [...new Set([...document.fonts].filter(face => face.status === "loaded").map(face => face.family))],
      strippedHandlers: nodes.reduce((sum, node) => sum + node.strippedHandlers, 0),
      contract: ["fragment-only", "shared-design-system-css", "base-root-host-themes", "font-variable-body-proxy", "idle-inert-no-authored-js", "no-viewport-dependent-css", "duplicate-id-fallback"], nodes: records,
    };
  };
  addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || data?.token !== token) return;
    if (data.type === "overview-shared-camera") {
      const next = data.camera;
      if (!next || ![next.x, next.y, next.z].every(Number.isFinite) || next.z <= 0) return;
      camera = next; world.style.transform = `matrix(${next.z},0,0,${next.z},${next.x},${next.y})`; return;
    }
    if (!Number.isSafeInteger(data.seq)) return;
    if (data.type === "overview-shared-policy") { batchSize = Math.max(0, Math.min(64, Math.floor(Number(data.batchSize) || 0))); contained = !!data.contained; post(data.seq, { batchSize, contained }); return; }
    if (data.type === "overview-shared-inspect") { post(data.seq, probe()); return; }
    if (data.type === "overview-shared-theme") {
      const expected = ++generation, start = performance.now();
      void render(String(data.theme), false, expected).then(async rebuilt => {
        if (expected === generation) await settle();
        if (expected !== generation) { post(data.seq, { superseded: true, generation: expected }); return; }
        const changedMs = performance.now() - start;
        post(data.seq, probe(changedMs, rebuilt));
      }).catch(error => post(data.seq, null, String(error)));
    }
  });
  const initialize = async () => {
    const expected = ++generation, rebuilt = await render(initialTheme, true);
    await settle(); if (expected !== generation) return;
    initMs = performance.now() - born; post(0, probe(initMs, rebuilt));
  };
  if (document.readyState === "complete") void initialize().catch(error => post(0, null, String(error)));
  else addEventListener("load", () => void initialize().catch(error => post(0, null, String(error))), { once: true });
}

/** Parent owns append/removal, camera admission and whether this restricted tier is appropriate. */
export function createSharedOverview(options: SharedOverviewOptions) {
  if (options.nodes.length > 300) throw new Error("Shared overview is capped at 300 source fragments");
  if (options.design.components.length > 64 || options.design.components.reduce((sum, c) => sum + c.html.length, 0) > 256 * 1024) throw new Error("Shared overview component byte/count budget");
  const base = new URL(options.base), css = new URL(options.cssUrl, base);
  if (!["http:", "https:"].includes(base.protocol) || css.origin !== base.origin) throw new Error("Shared overview requires its prepared local stylesheet origin");
  const globalReasons = stylesheetLimits(options.design.tokens);
  const componentResults = options.design.components.map(component => ({ component, sanitized: sanitizeFragment(component.html) }));
  const componentReasons = [...new Set(componentResults.flatMap(result => result.sanitized.reasons))];
  if (options.design.components.some(c => !/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.tag))) componentReasons.push("component-tag-outside-sharpner-format");
  if (componentReasons.length) globalReasons.push(...componentReasons.map(reason => "component:" + reason));
  const cleanComponents: ComponentDef[] = componentResults.map(({ component, sanitized }) => ({ ...component, html: sanitized.html }));
  const unsupported: { id: string; reasons: string[] }[] = [], nodes: SanitizedNode[] = [];
  let sourceBytes = 0;
  const seenNodes = new Set<string>();
  for (const node of options.nodes) {
    if (seenNodes.has(node.id)) throw new Error("Shared overview requires unique node IDs");
    seenNodes.add(node.id);
    sourceBytes += new TextEncoder().encode(node.source).byteLength;
    if (sourceBytes > MAX_SOURCE_BYTES) { unsupported.push({ id: node.id, reasons: ["source-byte-budget"] }); continue; }
    const sanitized = sanitizeFragment(node.source), reasons = [...globalReasons, ...sanitized.reasons];
    if (![node.width, node.x, node.y].every(Number.isFinite) || node.width <= 0 || node.width > 4000 || node.height !== null && (!Number.isFinite(node.height) || node.height < 1 || node.height > 8000)) reasons.push("invalid-geometry");
    if (reasons.length) unsupported.push({ id: node.id, reasons: [...new Set(reasons)] });
    else nodes.push({ ...node, source: sanitized.html, strippedHandlers: sanitized.strippedHandlers });
  }
  const frame = document.createElement("iframe"), token = crypto.randomUUID(), nonce = crypto.randomUUID();
  frame.sandbox.add("allow-scripts"); frame.title = "Shared declarative overview experiment";
  frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent;";
  frame.tabIndex = -1; frame.setAttribute("aria-hidden", "true"); frame.dataset.overviewShared = "true";
  const pending = new Map<number, { resolve: (probe: SharedOverviewProbe) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0, disposed = false, lastCamera: { camera: Camera; size: { w: number; h: number } } | null = null;
  const receive = (event: MessageEvent) => {
    const data = event.data;
    if (event.source !== frame.contentWindow || data?.type !== "overview-shared-reply" || data.token !== token) return;
    const request = pending.get(data.seq); if (!request) return;
    clearTimeout(request.timer); pending.delete(data.seq);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value as SharedOverviewProbe);
  };
  addEventListener("message", receive);
  const wait = (seq: number) => new Promise<SharedOverviewProbe>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error("Shared overview response deadline")); }, 12000);
    pending.set(seq, { resolve, reject, timer });
  });
  const ready = wait(0);
  const command = async (type: string, value: Record<string, unknown> = {}) => {
    await ready; if (disposed) throw new Error("Shared overview disposed");
    const seq = ++serial, result = wait(seq); frame.contentWindow!.postMessage({ type, token, seq, ...value }, "*"); return result;
  };
  const camera = (next: Camera, size: { w: number; h: number }) => {
    lastCamera = { camera: next, size };
    frame.style.width = `${size.w}px`; frame.style.height = `${size.h}px`;
    frame.contentWindow?.postMessage({ type: "overview-shared-camera", token, camera: next }, "*");
  };
  void ready.then(() => { if (lastCamera) camera(lastCamera.camera, lastCamera.size); }).catch(() => {});
  const renderDesign = { tokens: "", components: cleanComponents };
  const doc = frameDocument("", { design: renderDesign, compiledTailwind: true }).replace(/<script\b/g, `<script nonce="${nonce}"`);
  const trustedCss = `html,body{margin:0!important;width:100%;height:100%;overflow:hidden;background:transparent!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}`;
  const bridge = `(${sharedBridge.toString()})(${[token, nodes, options.theme, unsupported, sourceBytes, [...new Set(options.design.components.map(c => c.theme).filter((theme): theme is string => !!theme))], MAX_DOM_NODES].map(value => JSON.stringify(value).replace(/</g, "\\u003c")).join(",")})`;
  const policy = `default-src 'none';script-src 'nonce-${nonce}';style-src 'unsafe-inline' ${css.href};img-src data:;font-src data:;connect-src 'none';frame-src 'none';object-src 'none';worker-src 'none';media-src 'none';form-action 'none';base-uri 'none'`;
  frame.srcdoc = `<!doctype html><base href="${attribute(base.origin + "/")}"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">` + doc
    .replace("</head>", `<link rel="stylesheet" href="${attribute(css.href)}"><style>${trustedCss}</style></head>`)
    .replace("</body>", `<script nonce="${nonce}">${bridge}</script></body>`);
  return {
    frame, ready, setTheme: (theme: string) => command("overview-shared-theme", { theme }), camera,
    policy: (batchSize: number, contained = false) => command("overview-shared-policy", { batchSize, contained }),
    inspect: () => command("overview-shared-inspect"),
    dispose: () => {
      if (disposed) return; disposed = true; removeEventListener("message", receive); frame.remove();
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Shared overview disposed")); } pending.clear();
    },
  };
}
