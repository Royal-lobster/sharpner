// Shapes shared by the browser, the worker, and the FileRoom Durable Object. Vocabulary: see CONTEXT.md.
import { componentSpecimen, tokenSpecimen } from "./specimens";
import type { SessionPrincipal } from "./session-principal";
import { componentTheme, documentThemeScript } from "./themes";
export { tokenNames } from "./specimens";

/**
 * `description` says what a page holds and when to look at it, like a skill's description, so agents can pick
 * the right page without loading every node. A put without it keeps the current text.
 */
export type Page = { id: string; name: string; sort: number; description?: string; kind?: "canvas" | "design-system" };
/** File-owned Brand metadata, independent of the editable canvas guideline frame. */
export type Brand = { name: string; logoUrl: string; guidelines: string; voice: string[] };
export const emptyBrand = (): Brand => ({ name: "", logoUrl: "", guidelines: "", voice: [] });
export type DesignCatalog = { brand: Brand; pageId: string | null; primitives: CanvasNode[]; tokenSheets: number };
/** Longest page or section description, in characters. */
export const DESCRIPTION_MAX = 500;

/**
 * - frame: HTML rendered at a viewport width (a screen, state, slide…)
 * - image: an uploaded picture
 * - component: reusable HTML, used in frames as <x-name> instances (see componentTag)
 * - section: a labeled group that auto-fits the nodes whose parentId points at it
 * - tokens: a token sheet: Tailwind v4 CSS (`@theme { … }`) defining the file's tokens
 */
export type NodeKind = "frame" | "image" | "component" | "section" | "tokens";

/** Node metadata. Sources (HTML/CSS) load separately and lazily, because files can hold thousands of nodes. */
export type CanvasNode = {
  id: string;
  pageId: string;
  /** Section this node sits in, if any. */
  parentId: string | null;
  kind: NodeKind;
  name: string;
  /**
   * Frames: named theme override; null or missing inherits the file's theme.
   * Components: the theme this definition serves; null or missing is the default definition.
   */
  theme?: string | null;
  x: number;
  y: number;
  /** Stable sibling order for automatic layout. Optional only for older client metadata. */
  order?: number;
  /** Sections: automatic wrapping rows, or freely positioned contents. Missing means legacy free layout. */
  layout?: "auto" | "free";
  /** Sections: what the group holds and when to look at it, for agent navigation. Omitted when empty. */
  description?: string;
  width: number;
  /** null = grows to fit its content. */
  height: number | null;
  /** Content height measured by the thumbnail renderer, used to size auto-height nodes that aren't live. */
  measuredHeight: number | null;
  /** Images: URL of the original upload. */
  src: string | null;
  /** Raster previews used when the node is small on screen (lo ≈ 256px wide for the canvas layer, hi ≈ 1280px wide). */
  thumbLo: string | null;
  thumbHi: string | null;
  /** Bumps whenever what the node renders changes (its source, size, theme, or the design system it uses). */
  rev: number;
  /** Revision the current thumbnails show. Behind `rev` while the renderer catches up. */
  thumbRev?: number;
};

/** Whether the node's raster previews show its current revision (missing on older clients' metadata). */
export const previewCurrent = (node: Pick<CanvasNode, "rev" | "thumbRev" | "thumbHi">) =>
  !!node.thumbHi && (node.thumbRev === undefined || node.thumbRev >= node.rev);

/** Fields a client or agent may set. `source` is HTML for frames and components, CSS for token sheets. */
export type NodeInput = Partial<Pick<CanvasNode, "pageId" | "parentId" | "kind" | "name" | "theme" | "x" | "y" | "order" | "layout" | "description" | "width" | "height" | "src" | "thumbLo">> & {
  source?: string;
};

export type Op =
  | { t: "brand.set"; brand: Partial<Brand> }
  | { t: "page.put"; page: Page }
  | { t: "page.del"; id: string }
  /** Creates the node if `id` is new, otherwise merges the given fields. */
  | { t: "node.put"; id: string; node: NodeInput }
  | { t: "node.del"; ids: string[] }
  /** File theme inherited by frames without an override; null preserves authored theme contexts. */
  | { t: "theme.set"; theme: string | null }
  /** Pins a frame or image as the file's workspace cover; null restores automatic selection. */
  | { t: "cover.set"; id: string | null };

export type Actor = { id: string; name: string; avatar: string | null; agent?: boolean };

/** Coordinates are relative to the node's computed bounds, or to the page when nodeId is null. */
export type CommentAnchor = { pageId: string; nodeId: string | null; x: number; y: number };
export type CommentMessage = { id: string; author: Actor; body: string; createdAt: number };
/** Lightweight pin/list metadata. firstMessage.body is an excerpt; fetch the thread for full messages. */
export type CommentThread = {
  id: string; number: number; anchor: CommentAnchor; firstMessage: CommentMessage; messageCount: number;
  createdAt: number; updatedAt: number; resolvedAt: number | null; resolvedBy: Actor | null; revision: number;
};
export type CommentDetail = CommentThread & { messages: CommentMessage[] };

export type Presence = {
  pageId: string | null;
  selection: string[];
  cursor: { x: number; y: number } | null;
};

export type Peer = Actor & Presence & { cid: string };

/**
 * A component's HTML. A definition with a `theme` overrides the default inside that theme only, for
 * themes whose components need different structure (decoration, slots, layout), not just token values.
 */
export type ComponentDef = { tag: string; html: string; theme?: string | null };
/** Everything a frame needs to render consistently: token CSS and component definitions. */
export type DesignSystem = { tokens: string; components: ComponentDef[] };
export type LibraryInfo = { fileId: string; name: string; design: DesignSystem; catalog?: DesignCatalog };

export type ClientMsg =
  | { type: "ops"; ops: Op[] }
  | { type: "presence"; presence: Presence }
  | { type: "source"; ids: string[] };

export type ServerMsg =
  | { type: "init"; pages: Page[]; nodes: CanvasNode[]; cid: string; peers: Peer[]; library: LibraryInfo | null; brand?: Brand; comments?: CommentThread[]; sessionExpiresAt?: number; principal?: SessionPrincipal; coverNodeId?: string | null; fileTheme?: string | null }
  /** Full current state of everything an edit touched. Clients replace rather than merge. */
  | { type: "sync"; pages?: Page[]; pageDels?: string[]; nodes?: CanvasNode[]; nodeDels?: string[]; brand?: Brand; coverNodeId?: string | null; fileTheme?: string | null; by: Actor | null }
  | { type: "source"; items: { id: string; rev: number; source: string }[] }
  /** An agent is looking at or working on these nodes without changing them (reading, screenshotting). */
  | { type: "activity"; by: Actor; ids: string[] }
  /** The file's library changed (relinked, or its design system was edited). */
  | { type: "library"; library: LibraryInfo | null }
  | { type: "comments"; threads: CommentThread[]; deleted?: string[] }
  | { type: "peer"; peer: Peer }
  | { type: "peer.leave"; cid: string };

/** Custom element tag for a component name: "Button/Primary" -> "x-button-primary". */
export function componentTag(name: string) {
  return "x-" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "component");
}

/**
 * A file's design system: its library's, overridden by its own (own tokens come last in CSS). Components
 * are replaced per tag: a file defining a tag in any theme owns every definition of that tag.
 */
export function mergeDesignSystems(library: DesignSystem | null | undefined, own: DesignSystem): DesignSystem {
  if (!library) return own;
  const ownTags = new Set(own.components.map((c) => c.tag));
  return {
    tokens: [library.tokens, own.tokens].filter(Boolean).join("\n"),
    components: [...library.components.filter((c) => !ownTags.has(c.tag)), ...own.components],
  };
}

/**
 * Defines every component as a light-DOM custom element. `{{prop|default}}` placeholders take the element's
 * attributes and `<slot></slot>` takes its children. Expansion waits until the document is parsed, so an
 * instance's children are always there to slot (elements can upgrade mid-parse if a tag is already defined).
 *
 * Each instance uses the definition for the theme it renders in (see componentTheme), else the default.
 * Specimens pin their own definition with `data-sharpner-definition`, so a default stays visible in any theme.
 * Expansion runs before the document theme is applied, so the theme script announces it as `__sharpnerTheme`.
 */
const componentScript = (defs: ComponentDef[]) => {
  const byTag: Record<string, Record<string, string>> = {};
  for (const d of defs) (byTag[d.tag] ??= {})[d.theme ?? ""] = d.html;
  return String.raw`<script>(()=>{
const C=${JSON.stringify(byTag).replace(/</g, "\\u003c")};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const T=${componentTheme.toString()};
for(const[t,d]of Object.entries(C))if(!customElements.get(t))customElements.define(t,class extends HTMLElement{
connectedCallback(){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>this.x(),{once:true}):this.x()}
x(){if(this._x)return;this._x=1;if(this.parentElement&&this.parentElement.closest(t))return;
const p=this.getAttribute("data-sharpner-definition"),h=d[p??T(this,window.__sharpnerTheme)]??d[""];if(h==null)return;
const kids=this.innerHTML;this.style.display="contents";
this.innerHTML=h.replace(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g,(_,k,v)=>esc(this.hasAttribute(k)?this.getAttribute(k):(v||"").trim())).replace(/<slot\s*\/?>(\s*<\/slot>)?/gi,()=>kids);
}});})()</script>`;
};

/** Wraps HTML into the document rendered inside a live iframe, in thumbnails, and in screenshots. */
export function frameDocument(html: string, opts: { base?: string; measure?: boolean; design?: DesignSystem; theme?: string | null } = {}): string {
  // Remote @imports (web fonts) become <link>s; the rest is Tailwind CSS that defines the token utilities.
  const imports: string[] = [];
  const css = (opts.design?.tokens ?? "").replace(/@import\s+(?:url\()?\s*["']?(https?:[^"')\s]+)["']?\s*\)?[^;]*;/g, (_, href: string) => {
    imports.push(`<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`);
    return "";
  });
  // `@theme static` emits every token as a CSS variable, not only those some utility happens to use,
  // so `var(--color-…)` works in custom CSS and the token sheet specimen.
  const theme = css.replace(/@theme\s*\{/g, "@theme static {");
  const tokens = imports.join("") + (theme.trim() ? `<style type="text/tailwindcss">${theme.replace(/<\//g, "<\\/")}</style>` : "");
  const head =
    (opts.base ? `<base href="${opts.base}">` : "") +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>` +
    `<style>html,body{margin:0}body{-webkit-font-smoothing:antialiased}</style>` +
    tokens;
  // Reports content height to the canvas so auto-height frames can size themselves.
  const probe = opts.measure
    ? `<script>(()=>{let h=0;const post=()=>{const n=Math.ceil(document.body.getBoundingClientRect().height);if(n!==h){h=n;parent.postMessage({sharpnerHeight:n},"*")}};new ResizeObserver(post).observe(document.body);addEventListener("load",post)})()</script>`
    : "";
  const tail = (opts.design?.components.length ? componentScript(opts.design.components) : "") + documentThemeScript(opts.theme) + probe;
  if (/^\s*(<!doctype|<html)/i.test(html)) {
    const withHead = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + head)
      : html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
    return withHead.includes("</body>") ? withHead.replace("</body>", () => tail + "</body>") : withHead + tail;
  }
  return `<!doctype html><html><head>${head}</head><body>${html}${tail}</body></html>`;
}

/** Screens retain their source; design-system nodes get a consistent specimen presentation. */
export function renderedHtml(n: Pick<CanvasNode, "kind" | "name"> & Partial<Pick<CanvasNode, "height" | "theme">>, source: string) {
  if (n.kind === "component") return componentSpecimen(n.name, componentTag(n.name), source, n.height, n.theme);
  if (n.kind === "tokens") return tokenSpecimen(source, n.name);
  return source;
}
