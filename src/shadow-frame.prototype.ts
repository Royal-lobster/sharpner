// THROWAWAY PROTOTYPE: can ordinary isolated DOM replace overview raster frames?
// This is a static, declarative HTML experiment. Shadow DOM is NOT a security sandbox.
import type { PrototypeFrame, PrototypeReady, PrototypeSurface } from "./frame-surface.prototype";

const ROOT = "[data-prototype-html]", BODY = "[data-prototype-body]";
const CONTEXT = "[data-theme],.dark,.light";
const CONTAINER = "sharpner-prototype-viewport";
const sheets = new Map<string, {sheet: CSSStyleSheet; issues: string[]}>();
const imports = new Map<string, Promise<string>>();
const fonts = new Map<string, FontFace>();
const htmlTags = new Set("a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main map mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr".split(" "));
const svgTags = new Set("svg g path rect circle ellipse line polyline polygon text tspan defs clipPath mask linearGradient radialGradient stop filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence title desc symbol use".toLowerCase().split(" "));
const diagnostics = (issues: Set<string>, reason: string) => issues.add(reason);
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function absoluteUrls(value: string, base: string) {
  return value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, _quote: string, url: string) => {
    if (!url || url.startsWith("#") || /^(?:data|blob):/i.test(url)) return whole;
    try { return `url(${JSON.stringify(new URL(url, base).href)})`; } catch { return "none"; }
  });
}

/** Rewrite viewport-relative values, while leaving quoted content and image URLs alone. */
function localUnits(value: string) {
  return value.replace(/url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(-?(?:\d*\.)?\d+)(dvh|svh|lvh|vh|dvw|svw|lvw|vw|vmin|vmax)\b/g,
    (whole, amount: string | undefined, unit: string | undefined) => amount === undefined ? whole : `calc(${amount} * var(--prototype-${unit!.endsWith("vh") ? "vh" : unit!.endsWith("vw") ? "vw" : unit}))`);
}

function localSelector(selector: string) {
  // Skip strings and attribute selectors: an attribute whose value is "body" is not a type selector.
  return selector.replace(/\[(?:\\.|[^\]\\])*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|:host\(([^)]+)\)|:host\b|:root\b|(?<![\w.#:-])(html|body)(?![\w-])/g,
    (whole, host: string | undefined, tag: string | undefined) => whole.startsWith("[") || whole.startsWith('"') || whole.startsWith("'") ? whole : host !== undefined ? `${ROOT}${host}` : tag === "body" ? BODY : ROOT);
}

function fontRule(rule: CSSFontFaceRule, base: string) {
  const key = absoluteUrls(rule.cssText, base);
  if (fonts.has(key)) return;
  const style = rule.style;
  const family = style.getPropertyValue("font-family").trim().replace(/^(['"])(.*)\1$/, "$2");
  const src = absoluteUrls(style.getPropertyValue("src"), base);
  if (!family || !src) return;
  const descriptors: Record<string, string> = {};
  for (const [css, js] of [["font-style", "style"], ["font-weight", "weight"], ["font-stretch", "stretch"], ["unicode-range", "unicodeRange"], ["font-display", "display"], ["font-feature-settings", "featureSettings"], ["font-variation-settings", "variationSettings"]]) {
    const value = style.getPropertyValue(css!); if (value) descriptors[js!] = value;
  }
  const face = new FontFace(family, src, descriptors);
  // FontFace is registered without eager load: layout requests only the actual faces/glyph subsets.
  document.fonts.add(face);
  fonts.set(key, face);
}

function scopedSheet(css: string, base: string, issues: Set<string>): CSSStyleSheet {
  const key = `${base}\n${css}`;
  const cached = sheets.get(key);
  if (cached) { for (const reason of cached.issues) issues.add(reason); return cached.sheet; }
  const previousIssues = new Set(issues);
  const original = new CSSStyleSheet();
  original.replaceSync(css);
  function serialize(rule: CSSRule): string {
    if (rule instanceof CSSFontFaceRule) { fontRule(rule, base); return ""; }
    if (rule instanceof CSSStyleRule) {
      const declarations = localUnits(absoluteUrls(rule.style.cssText, base));
      const nested = "cssRules" in rule ? [...rule.cssRules].map(serialize).join("\n") : "";
      return `${localSelector(rule.selectorText)}{${declarations}${nested}}`;
    }
    if (rule instanceof CSSMediaRule) {
      const condition = rule.conditionText;
      const sizeQuery = /(?:^|[\s(])(?:(?:min|max)-)?(?:width|height)\b/.test(condition);
      if (sizeQuery) {
        const local = condition.replace(/^(?:only\s+)?(?:screen|all)\s+and\s+/i, "");
        if (/(?:prefers-|hover|pointer|resolution|orientation|aspect-ratio|print|screen)/i.test(local)) diagnostics(issues, "Mixed/complex frame media queries are not equivalent inside Shadow DOM");
        return `@container ${CONTAINER} ${local}{${[...rule.cssRules].map(serialize).join("\n")}}`;
      }
      return `@media ${condition}{${[...rule.cssRules].map(serialize).join("\n")}}`;
    }
    if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule)) {
      const grouping = rule as CSSGroupingRule;
      return `${rule.cssText.slice(0, rule.cssText.indexOf("{"))}{${[...grouping.cssRules].map(serialize).join("\n")}}`;
    }
    return localUnits(absoluteUrls(rule.cssText, base));
  }
  const text = [...original.cssRules].map(serialize).join("\n");
  const sheet = new CSSStyleSheet(); sheet.replaceSync(text);
  sheets.set(key, {sheet, issues:[...issues].filter((issue)=>!previousIssues.has(issue))});
  while (sheets.size > 8) sheets.delete(sheets.keys().next().value!);
  return sheet;
}

async function styles(css: string, base: string, issues: Set<string>, depth = 0): Promise<CSSStyleSheet[]> {
  if (depth > 3) { diagnostics(issues, "CSS import recursion exceeds prototype limit"); return []; }
  const imported: CSSStyleSheet[] = [];
  const declarations = [...css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?([^;]*);/g)];
  let own = css;
  for (const [declaration, source, condition] of declarations) {
    own = own.replace(declaration, "");
    if (condition?.trim()) diagnostics(issues, "Conditional CSS imports need an iframe");
    if (!/^https?:/i.test(source!)) { diagnostics(issues, "Non-HTTP CSS import omitted"); continue; }
    try {
      const url = new URL(source!, base).href;
      let text = imports.get(url);
      if (!text) {
        text = fetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.text(); });
        imports.set(url, text);
        while (imports.size > 8) imports.delete(imports.keys().next().value!);
      }
      imported.push(...await styles(await text, url, issues, depth + 1));
    } catch { diagnostics(issues, "An external stylesheet could not be read through CORS"); }
  }
  return [...imported, scopedSheet(own, base, issues)];
}

function safeUrl(value: string, image = false) {
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, "");
  return !/^[a-z][a-z0-9+.-]*:/i.test(compact) || /^(?:https?|blob):/i.test(compact) || image && /^data:image\//i.test(compact);
}

function sanitize(root: HTMLElement, issues: Set<string>, components: Set<string>) {
  for (const element of [root,...root.querySelectorAll("*")]) {
    const tag = element.localName;
    const svg = element.namespaceURI === "http://www.w3.org/2000/svg";
    const knownComponent = components.has(tag);
    if (!(svg ? svgTags.has(tag.toLowerCase()) : htmlTags.has(tag) || knownComponent || element.hasAttribute("data-prototype-html") || element.hasAttribute("data-prototype-body"))) {
      diagnostics(issues, `<${tag}> is unsupported in the script-free Shadow DOM experiment`);
      element.remove(); continue;
    }
    if (element.hasAttribute("is")) { diagnostics(issues, "Customized built-in elements are unsupported"); element.remove(); continue; }
    if (knownComponent && customElements.get(tag)) {
      diagnostics(issues, "A component tag collides with a custom element registered by the editor");
      element.remove(); continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(), value = attribute.value;
      if (name.startsWith("on") || ["srcdoc", "autofocus", "action", "formaction", "is"].includes(name)) {
        diagnostics(issues, `Active attribute ${name} is unsupported`); element.removeAttribute(attribute.name);
      } else if (["src", "href", "xlink:href", "poster"].includes(name)) {
        if (!safeUrl(value, ["img", "source", "image", "use", "feimage"].includes(tag.toLowerCase()))) {
          diagnostics(issues, `Unsafe URL in ${name} omitted`); element.removeAttribute(attribute.name);
        } else if (value && !value.startsWith("#")) {
          try { element.setAttribute(attribute.name, new URL(value, location.origin + "/").href); } catch { element.removeAttribute(attribute.name); }
        }
      } else if (name === "srcset" && /(?:javascript|vbscript|data:(?!image))/i.test(value)) {
        diagnostics(issues, "Unsafe srcset omitted"); element.removeAttribute(attribute.name);
      } else if (name === "style") element.setAttribute("style", localUnits(absoluteUrls(value, location.origin + "/")));
    }
  }
}

type AuthoredTheme = { element: HTMLElement; classes: string | null; theme: string | null; colorScheme: string; colorSchemePriority: string };
function authoredThemes(html: HTMLElement, body: HTMLElement): AuthoredTheme[] {
  return [html, body, ...body.querySelectorAll<HTMLElement>(CONTEXT)].map((element) => ({ element, classes: element.getAttribute("class"), theme: element.getAttribute("data-theme"), colorScheme: element.style.getPropertyValue("color-scheme"), colorSchemePriority: element.style.getPropertyPriority("color-scheme") }));
}
function applyTheme(authored: AuthoredTheme[], html: HTMLElement, body: HTMLElement, theme: string | undefined) {
  for (const original of authored) {
    original.classes === null ? original.element.removeAttribute("class") : original.element.setAttribute("class", original.classes);
    original.theme === null ? original.element.removeAttribute("data-theme") : original.element.setAttribute("data-theme", original.theme);
    if (original.colorScheme) original.element.style.setProperty("color-scheme", original.colorScheme, original.colorSchemePriority); else original.element.style.removeProperty("color-scheme");
  }
  if (theme === undefined) return;
  const outer = [...body.querySelectorAll<HTMLElement>(CONTEXT)].filter((element) => {
    const parent = element.parentElement?.closest(CONTEXT); return !parent || parent === body || parent === html;
  });
  for (const root of [html, body, ...outer]) {
    root.dataset.theme = theme; root.classList.remove("light", "dark");
    if (theme === "light" || theme === "dark") root.classList.add(theme);
  }
  html.style.colorScheme = theme === "light" ? "light" : theme === "dark" ? "dark" : "normal";
}

function expand(body: HTMLElement, html: HTMLElement, frame: PrototypeFrame) {
  const definitions = new Map<string, Map<string, string>>();
  for (const definition of frame.design.components) {
    const byTheme = definitions.get(definition.tag) ?? new Map<string, string>();
    byTheme.set(definition.theme ?? "", definition.html); definitions.set(definition.tag, byTheme);
  }
  const outer = (element: Element | null | undefined) => !element || element === body || element === html;
  const name = (element: Element) => element.getAttribute("data-theme") || (element.classList.contains("dark") ? "dark" : element.classList.contains("light") ? "light" : "");
  function visit(parent: Element) {
    for (const element of [...parent.children]) {
      const byTheme = definitions.get(element.localName);
      if (byTheme && !element.parentElement?.closest(element.localName)) {
        const context = element.parentElement?.closest(CONTEXT);
        const theme = frame.theme !== undefined && (outer(context) || outer(context?.parentElement?.closest(CONTEXT))) ? frame.theme : context ? name(context) : "";
        const selected = byTheme.get(element.getAttribute("data-sharpner-definition") ?? theme) ?? byTheme.get("");
        if (selected !== undefined) {
          const children = element.innerHTML;
          element.setAttribute("style", "display:contents");
          element.innerHTML = selected.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g, (_, key: string, fallback: string | undefined) => escapeHtml(element.hasAttribute(key) ? element.getAttribute(key)! : (fallback ?? "").trim()))
            .replace(/<slot\s*\/?>(\s*<\/slot>)?/gi, () => children);
        }
      }
      visit(element);
    }
  }
  visit(body);
  return new Set(definitions.keys());
}

/**
 * Static declarative frames only. It intentionally reports unsupported author features instead of
 * treating Shadow DOM as a sandbox. The prototype is not a production HTML sanitizer.
 */
export function mountShadowFrame(host: HTMLElement): PrototypeSurface {
  const viewport = document.createElement("div");
  viewport.dataset.prototypeSurface = "shadow";
  viewport.style.cssText = "all:initial;display:block;position:relative;isolation:isolate;contain:layout style paint;container-type:size;container-name:" + CONTAINER + ";overflow:hidden";
  // CSS custom properties cross shadow roots, so prevent app variables from filling missing file tokens.
  for (const property of getComputedStyle(document.documentElement)) if (property.startsWith("--")) viewport.style.setProperty(property, "initial");
  const shadow = viewport.attachShadow({ mode: "open" });
  const prevent = (event: Event) => event.preventDefault();
  shadow.addEventListener("click", prevent); shadow.addEventListener("submit", prevent);
  host.appendChild(viewport);
  let epoch = 0, disposed = false;
  let state: { frame: PrototypeFrame; html: HTMLElement; body: HTMLElement; authored: AuthoredTheme[]; componentKey: string; issues: Set<string>; css: CSSStyleSheet[]; localCss: CSSStyleSheet[] } | undefined;

  return {
    async update(frame): Promise<PrototypeReady> {
      const current = ++epoch;
      const issues = new Set<string>();
      const componentKey = JSON.stringify(frame.design.components);
      const hasThemeDefinitions = frame.design.components.some((definition) => definition.theme != null);
      const reuse = state && state.frame.html === frame.html && state.componentKey === componentKey && state.frame.design.tokens === frame.design.tokens && (!hasThemeDefinitions || state.frame.theme === frame.theme);
      viewport.style.width = `${frame.width}px`;
      viewport.style.height = `${frame.height ?? 800}px`;
      const shared = state?.frame.css === frame.css ? state.css : await styles(frame.css, location.origin + "/", issues);
      if (current !== epoch || disposed) return { supported: false, measuredHeight: 0, reason: "Superseded Shadow DOM update" };
      if (!reuse) {
        const documentSource = new DOMParser().parseFromString(frame.html, "text/html");
        const html = documentSource.createElement("div"), body = documentSource.createElement("div");
        for (const attribute of [...documentSource.documentElement.attributes]) html.setAttribute(attribute.name, attribute.value);
        for (const attribute of [...documentSource.body.attributes]) body.setAttribute(attribute.name, attribute.value);
        html.dataset.prototypeHtml = ""; body.dataset.prototypeBody = "";
        html.style.display = body.style.display = "block";
        body.style.margin = "0"; body.style.setProperty("-webkit-font-smoothing", "antialiased");
        html.appendChild(body);
        const localStyles: CSSStyleSheet[] = [];
        const styleNodes = [...documentSource.querySelectorAll<HTMLStyleElement>("style")];
        for (const style of styleNodes) {
          if (style.type !== "text/tailwindcss") localStyles.push(...await styles(style.textContent ?? "", location.origin + "/", issues));
          style.remove();
        }
        for (const link of documentSource.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
          localStyles.push(...await styles(`@import url(${JSON.stringify(new URL(link.getAttribute("href") ?? "", location.origin + "/").href)});`, location.origin + "/", issues));
          link.remove();
        }
        // Token @imports become links in frameDocument. Read their CSS without exposing global styles.
        const tokenImports = [...frame.design.tokens.matchAll(/@import\s+(?:url\()?\s*["']?(https?:[^"')\s]+)["']?\s*\)?[^;]*;/g)].map((match) => match[0]);
        for (const declaration of tokenImports) localStyles.push(...await styles(declaration, location.origin + "/", issues));
        for (const node of [...documentSource.body.childNodes]) body.appendChild(node);
        const components = expand(body, html, frame);
        // Component definitions can introduce styles and active content too.
        for (const style of [...body.querySelectorAll<HTMLStyleElement>("style")]) {
          if (style.type !== "text/tailwindcss") localStyles.push(...await styles(style.textContent ?? "", location.origin + "/", issues));
          style.remove();
        }
        if (documentSource.head.querySelector("script")) diagnostics(issues, "Author scripts cannot run in the Shadow DOM surface");
        sanitize(html, issues, components);
        if (html.style.fontSize && html.style.fontSize !== "16px") diagnostics(issues, "Authored root font-size changes rem units globally in an iframe; Shadow DOM cannot reproduce that");
        const authored = authoredThemes(html, body);
        if (current !== epoch || disposed) return { supported: false, measuredHeight: 0, reason: "Superseded Shadow DOM update" };
        shadow.adoptedStyleSheets = [...shared, ...localStyles];
        shadow.replaceChildren(html);
        state = {frame,html,body,authored,componentKey,issues,css:shared,localCss:localStyles};
      } else {
        for (const reason of state!.issues) issues.add(reason);
        if (state!.frame.css !== frame.css) shadow.adoptedStyleSheets = [...shared,...state!.localCss];
        state!.frame = frame; state!.issues = issues; state!.css = shared;
      }
      const {html,body,authored} = state!;
      const viewportHeight = frame.height ?? 800;
      for (const [unit, value] of [["vw",frame.width/100],["vh",viewportHeight/100],["vmin",Math.min(frame.width,viewportHeight)/100],["vmax",Math.max(frame.width,viewportHeight)/100]] as const) html.style.setProperty(`--prototype-${unit}`,`${value}px`);
      applyTheme(authored, html, body, frame.theme);
      // Scroll/offset sizes ignore the outer world transform; client rects do not.
      body.getBoundingClientRect();
      await Promise.all([document.fonts.ready, ...[...body.querySelectorAll("img")].filter((image)=>!image.complete).map((image)=>new Promise<void>((resolve)=>{
        image.addEventListener("load",()=>resolve(),{once:true}); image.addEventListener("error",()=>resolve(),{once:true});
      }))]);
      if (current !== epoch || disposed) return { supported: false, measuredHeight: 0, reason: "Superseded Shadow DOM update" };
      const measuredHeight = Math.ceil(body.offsetHeight);
      if (frame.height === null) viewport.style.height = `${measuredHeight}px`;
      return {measuredHeight,domNodes:shadow.querySelectorAll("*").length+1,supported:issues.size===0,...(issues.size?{reason:[...issues].join("; ")}: {})};
    },
    dispose() { disposed=true;epoch++;viewport.remove(); },
  };
}
