import { componentName, componentProps } from "./specimens";
import { themeNames } from "./themes";
import { componentTag, type Brand, type CanvasNode, type DesignSystem, type LibraryInfo } from "./types";

export const RECOMMENDED_FAMILIES = ["Button", "Badge", "Input", "Textarea", "Label", "Field", "Select", "Checkbox", "Radio Group", "Switch", "Slider", "Toggle Group", "Tabs", "Card", "Alert", "Dialog", "Sheet", "Drawer", "Popover", "Tooltip", "Dropdown Menu", "Avatar", "Separator", "Skeleton", "Spinner", "Progress", "Table", "Toast", "Breadcrumb", "Pagination", "Accordion", "Empty"];
export const COLOR_SLOTS = ["background", "foreground", "card", "popover", "primary", "primary-foreground", "secondary", "muted", "muted-foreground", "accent", "destructive", "border", "input", "ring", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground", "destructive-foreground"];
export const MAX_LIVE_PREVIEWS = 16;
export const COLLAPSED_VARIANTS = 6;

/** Patch individual fields, so independent member/agent changes do not erase the other brand fields. */
export function patchBrand(current: Brand, patch: Partial<Brand>): Brand {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Brand must be an object");
  const result = { ...current };
  for (const [key, max] of [["name", 200], ["logoUrl", 2048], ["guidelines", 2000]] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== "string" || value.length > max) throw new Error(`Brand ${key} must be text of at most ${max} characters`);
    result[key] = value.trim();
  }
  if (result.logoUrl && !/^(https?:\/\/|\/a\/)/i.test(result.logoUrl)) throw new Error("Brand logo must be an http(s) image URL or an uploaded /a/ image");
  if ("voice" in patch) {
    if (!Array.isArray(patch.voice) || patch.voice.length > 8 || patch.voice.some((v) => typeof v !== "string" || v.length > 500)) throw new Error("Brand voice must contain up to 8 bullets of at most 500 characters");
    result.voice = patch.voice.map((v) => v.trim()).filter(Boolean);
  }
  return result;
}

export type FoundationToken = { name: string; description: string; utility: string; values: Record<string, string>; local: boolean };
export function tokenUtility(name: string) {
  if (name.startsWith("--color-")) { const slot = name.slice(8); return `${slot.includes("foreground") || slot === "destructive" ? "text" : slot === "border" || slot === "input" ? "border" : slot === "ring" ? "ring" : "bg"}-${slot}`; }
  for (const [prefix, utility] of [["font-weight-", "font-"], ["font-", "font-"], ["text-", "text-"], ["radius-", "rounded-"], ["shadow-", "shadow-"], ["spacing-", "p-"]]) if (name.startsWith(`--${prefix}`)) return utility + name.slice(prefix!.length + 2);
  return name === "--spacing" ? "p-1" : name === "--radius" ? "rounded" : name === "--shadow" ? "shadow" : `var(${name})`;
}

/** Only unconditional root/theme rules describe file-wide foundations. Scoped/conditional CSS stays in live previews. */
function tokenRules(css: string) {
  const rules: { selector: string; body: string }[] = [];
  const stack: { selector: string; start: number; nested: boolean; excluded: boolean }[] = [];
  let header = 0;
  // Skip strings and comments when finding blocks, including braces in token strings and URLs.
  for (const m of css.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]/g)) {
    if (m[0] === "{") {
      const selector = css.slice(header, m.index).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const parent = stack.at(-1);
      if (parent) parent.nested = true;
      stack.push({ selector, start: m.index + 1, nested: false, excluded: !!parent && (parent.excluded || !/^@layer\b/.test(parent.selector)) });
      header = m.index + 1;
    } else if (m[0] === "}") {
      const block = stack.pop();
      if (block && !block.nested && !block.excluded) rules.push({ selector: block.selector, body: css.slice(block.start, m.index) });
      header = m.index + 1;
    } else if (m[0] === ";") header = m.index + 1;
  }
  return rules;
}

/** A supported selector's specificity when it matches a themed document root. Descendants never become global tokens. */
function tokenSpecificity(selector: string, theme: string) {
  if (/^@theme(?:\s+(?:inline|static|reference|default))*$/.test(selector)) return -1;
  const names: string[] = [];
  const stripped = selector.replace(/\[data-theme\s*=\s*(?:"([^"\\]+)"|'([^'\\]+)'|([\w-]+))\s*\]|\.(dark|light)(?![\w-])/g, (...m: string[]) => {
    names.push(m[1] || m[2] || m[3] || m[4]!); return "X";
  });
  if (/\s/.test(stripped) || names.some((name) => name !== theme)) return null;
  const root = stripped.replace(/X/g, "");
  if (!["", ":root", "html", "body"].includes(root) || !root && !names.length) return null;
  return names.length * 100 + (root === ":root" ? 100 : root ? 1 : 0);
}

const tokenSelectors = (selector: string) => selector.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g)?.map((s) => s.trim()) ?? [];

/** Read declared root tokens with specificity and source order; references remain CSS for browser resolution. */
export function foundations(css: string, localCss = css, themes = themeNames(css)) {
  const vars: Record<string, Record<string, string>> = Object.fromEntries(themes.map((t) => [t, {}]));
  const priorities: Record<string, Record<string, number>> = Object.fromEntries(themes.map((t) => [t, {}]));
  const descriptions = new Map<string, string>(), names = new Set<string>();
  for (const { selector, body } of tokenRules(css)) {
    // Commas inside a quoted theme name are not selector separators.
    const selectors = tokenSelectors(selector);
    const targets = themes.flatMap((t) => {
      const scores = selectors.map((s) => tokenSpecificity(s, t)).filter((score) => score !== null);
      return scores.length ? [{ theme: t, specificity: Math.max(...scores) }] : [];
    });
    if (!targets.length) continue;
    let leading = "", lastName = "", lastEnd = 0;
    for (const m of body!.matchAll(/\/\*([\s\S]*?)\*\/|(--[\w-]+)\s*:\s*([^;]+?)(?:;|$)/g)) {
      if (m[1] !== undefined) {
        const comment = m[1].trim().replace(/\s+/g, " ");
        if (lastName && !/\S|\n/.test(body!.slice(lastEnd, m.index))) descriptions.set(lastName, comment);
        else leading = comment;
        continue;
      }
      const name = m[2]!, value = m[3]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!value) continue;
      names.add(name);
      const important = /\s*!important\s*$/i.test(value), actual = value.replace(/\s*!important\s*$/i, "");
      for (const { theme, specificity } of targets) {
        const priority = specificity + (important ? 1_000_000 : 0);
        if (priority < (priorities[theme]![name] ?? -Infinity)) continue;
        priorities[theme]![name] = priority;
        vars[theme]![name] = actual === "initial" ? "" : actual;
      }
      if (leading) descriptions.set(name, leading);
      leading = ""; lastName = name; lastEnd = m.index + m[0].length;
    }
  }
  const localNames = new Set(tokenRules(localCss).filter((r) => tokenSelectors(r.selector).some((s) => themes.some((t) => tokenSpecificity(s, t) !== null)))
    .flatMap((r) => [...r.body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)));
  const tokens: FoundationToken[] = [...names].map((name) => ({ name, description: descriptions.get(name) ?? "", utility: tokenUtility(name), local: localNames.has(name), values: Object.fromEntries(themes.flatMap((t) => vars[t]![name] ? [[t, vars[t]![name]!]] : [])) })).filter((t) => Object.keys(t.values).length);
  const slotOrder = (name: string) => { const i = COLOR_SLOTS.indexOf(name.slice(8)); return i < 0 ? COLOR_SLOTS.length : i; };
  const colors = tokens.filter((t) => t.name.startsWith("--color-")).sort((a, b) => slotOrder(a.name) - slotOrder(b.name) || a.name.localeCompare(b.name));
  return { themes, vars, colors, type: tokens.filter((t) => /^--(?:font-|text-)/.test(t.name)), spacing: tokens.filter((t) => /^--spacing(?:-|$)/.test(t.name)), radii: tokens.filter((t) => /^--radius(?:-|$)/.test(t.name)), shadows: tokens.filter((t) => /^--shadow(?:-|$)/.test(t.name)) };
}

/** Preserve the library's original read-only values alongside local additions/overrides. Rendering uses merged values. */
export function documentFoundations(libraryCss: string, localCss: string) {
  const effective = foundations([libraryCss, localCss].filter(Boolean).join("\n"), localCss);
  const inherited = foundations(libraryCss, "", effective.themes);
  const libraryVars = Object.fromEntries(effective.themes.map((t) => [t, {
    ...Object.fromEntries(Object.keys(effective.vars[t]!).map((name) => [name, "initial"])), ...inherited.vars[t],
  }]));
  const rows = (group: "colors" | "type" | "spacing" | "radii" | "shadows") => [...inherited[group], ...effective[group].filter((t) => t.local)];
  const order = new Map(effective.colors.map((t, index) => [t.name, index]));
  return { ...effective, libraryVars, colors: rows("colors").sort((a, b) => (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity)), type: rows("type"), spacing: rows("spacing"), radii: rows("radii"), shadows: rows("shadows") };
}

const familyKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
export function canonicalFamily(name: string) {
  const key = familyKey(name), alias = ({ radio: "Radio Group", tab: "Tabs", toggle: "Toggle Group" } as Record<string, string>)[key];
  return alias ?? RECOMMENDED_FAMILIES.find((f) => familyKey(f) === key) ?? name;
}
export type Primitive = { node: CanvasNode; tag: string; variant: string; source: string; props: ReturnType<typeof componentProps>; slot: boolean; library: boolean };
export type PrimitiveFamily = { name: string; variants: { tag: string; name: string; definitions: Primitive[] }[] };

/** Placement registers primitives; local ownership of a tag replaces every library definition of it. */
export function primitiveFamilies(nodes: CanvasNode[], pageId: string, design: DesignSystem, library: LibraryInfo | null): PrimitiveFamily[] {
  const ownTags = new Set(nodes.filter((n) => n.kind === "component").map((n) => componentTag(n.name)));
  const candidates = [...(library?.catalog?.primitives ?? []).filter((n) => !ownTags.has(componentTag(n.name))).map((node) => ({ node, library: true })), ...nodes.filter((n) => n.kind === "component" && n.pageId === pageId).map((node) => ({ node, library: false }))];
  const families = new Map<string, PrimitiveFamily>();
  for (const candidate of candidates) {
    const { node } = candidate, tag = componentTag(node.name), parts = componentName(node.name), name = canonicalFamily(parts.family);
    const source = design.components.find((c) => c.tag === tag && (c.theme ?? null) === (node.theme ?? null))?.html;
    if (source === undefined) continue;
    const family = families.get(name) ?? { name, variants: [] };
    families.set(name, family);
    let variant = family.variants.find((v) => v.tag === tag);
    if (!variant) { variant = { tag, name: parts.variant, definitions: [] }; family.variants.push(variant); }
    variant.definitions.push({ ...candidate, tag, variant: parts.variant, source, props: componentProps(source), slot: /<slot[\s/>]/i.test(source) });
  }
  const rank = (name: string) => { const i = RECOMMENDED_FAMILIES.indexOf(name); return i < 0 ? RECOMMENDED_FAMILIES.length : i; };
  for (const f of families.values()) for (const v of f.variants) v.definitions.sort((a, b) => Number(!!a.node.theme) - Number(!!b.node.theme) || (a.node.theme ?? "").localeCompare(b.node.theme ?? ""));
  return [...families.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The same bounded selection drives the mounted iframes, regardless of family count. */
export const livePreviewIds = (ordered: string[], visible: ReadonlySet<string>) => new Set(ordered.filter((id) => visible.has(id)).slice(0, MAX_LIVE_PREVIEWS));
