// The part of a design system one live or playback document renders with. Vocabulary: see CONTEXT.md.
import type { DesignSystem } from "./types";

/*
 * Tag names an author builds at runtime instead of writing them out, which no text search can follow. Each
 * starts with an "x-" prefix at a word start ("max-w-${size}" does not count) and continues into a value
 * only known later:
 * - a template literal interpolation: `x-${name}`, `<x-card-${variant}>`
 * - a component placeholder: <x-icon-{{name}}>
 * - a string literal joined to something else: "x-" + name, 'x-card-'+variant, "x-".concat(name)
 * - a string literal ending in a hyphen, kept as a prefix: const prefix = "x-"
 * A quote may also be backslash-escaped (JSON in a script) or an HTML entity: an inline event handler
 * such as onclick="make(&quot;x-&quot; + kind)" decodes its attribute before the script runs.
 * Tags assembled from pieces that never spell "x-" ("x" + "-", [..].join("-")) are not detected.
 */
const QUOTE = String.raw`(?:\\?["'${"`"}]|&(?:quot|apos|#0*3[49]|#x0*2[27]);)`;
const DYNAMIC_TAG = new RegExp(String.raw`(?<![\w-])x-(?:[\w-]*(?:\$\{|\{\{|${QUOTE}\s*(?:\+|\.\s*concat\b))|(?:[\w-]*-)?${QUOTE})`, "i");

/** Tags that matched as plain text; anything else (an older library's tag, say) falls back to a substring search. */
const PLAIN_TAG = /^x-[a-z0-9-]*$/;

/**
 * Whether `tag` occurs anywhere in `text`, ignoring case as HTML does. Every occurrence of a plain tag starts
 * at some "x-" and lies within the run of tag characters after it, so the distinct runs answer every tag at once.
 * A run is cut at the longest tag's length, so text like "x-x-x-…" stays linear.
 */
function mentions(text: string, longest: number) {
  const lower = text.toLowerCase();
  const runs = new Set<string>();
  const run = new RegExp(`[a-z0-9-]{0,${longest}}`, "y");
  for (let at = lower.indexOf("x-"); at >= 0; at = lower.indexOf("x-", at + 1)) {
    run.lastIndex = at;
    runs.add(run.exec(lower)![0]);
  }
  return (tag: string) => {
    const name = tag.toLowerCase();
    if (!PLAIN_TAG.test(name)) return lower.includes(name);
    for (const found of runs) if (found.startsWith(name)) return true;
    return false;
  };
}

function scope(html: string, design: DesignSystem): DesignSystem {
  const { components } = design;
  const used = components.map(() => false);
  const longest = Math.max(...components.map((c) => c.tag.length));
  // The document, then each component it pulls in, so nested instances come along.
  const pending = [html];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    if (DYNAMIC_TAG.test(text)) return design;
    const has = mentions(text, longest);
    components.forEach((c, i) => {
      if (!used[i] && has(c.tag)) { used[i] = true; pending.push(c.html); }
    });
  }
  const kept = components.filter((_, i) => used[i]);
  return kept.length === components.length ? design : { tokens: design.tokens, components: kept };
}

const scopes = new WeakMap<DesignSystem, { byHtml: Map<string, DesignSystem>; chars: number }>();
/** Documents remembered per design: the live budget plus playback, with room for edits in flight. */
const SCOPES_PER_DESIGN = 32;
/**
 * The keys are whole documents, which can outlive the room's source cache while one design object lasts
 * (frame edits do not replace it), so the memo is bounded by text as well as count.
 */
const SCOPE_CHARS_PER_DESIGN = 4 * 1024 * 1024;

/**
 * The design system with only the components `html` uses: each one whose tag appears anywhere in it, scripts
 * included, and each one those use in turn, in design order. HTML that builds tag names at runtime keeps
 * every component. A live or playback document built from this stays byte-identical when an unrelated
 * component changes, so its iframe and session survive. Thumbnails and screenshots scope their documents too.
 */
export function scopeDesign(html: string, design: DesignSystem): DesignSystem {
  if (!design.components.length) return design;
  let memo = scopes.get(design);
  if (!memo) scopes.set(design, memo = { byHtml: new Map(), chars: 0 });
  let scoped = memo.byHtml.get(html);
  if (!scoped) {
    memo.byHtml.set(html, scoped = scope(html, design));
    memo.chars += html.length;
    // Oldest first, always keeping the newest, so a design that outlives many source edits does not hold
    // every superseded document.
    for (const old of memo.byHtml.keys()) {
      if (old === html || (memo.byHtml.size <= SCOPES_PER_DESIGN && memo.chars <= SCOPE_CHARS_PER_DESIGN)) break;
      memo.byHtml.delete(old);
      memo.chars -= old.length;
    }
  }
  return scoped;
}
