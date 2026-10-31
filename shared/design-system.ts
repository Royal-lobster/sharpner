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

/** Read declared tokens only. CSS custom properties retain references so the browser resolves aliases. */
export function foundations(css: string, localCss = css) {
  const themes = themeNames(css), base: Record<string, string> = {}, overrides: Record<string, Record<string, string>> = {};
  const descriptions = new Map<string, string>(), names = new Set<string>();
  for (const [, selector, body] of css.matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
    const cleanSelector = selector!.replace(/\/\*[\s\S]*?\*\//g, "");
    const named = [...cleanSelector.matchAll(/\[data-theme\s*=\s*(?:"([^"\\]+)"|'([^'\\]+)'|([\w-]+))\s*\]|\.(dark|light)(?![\w-])/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!);
    if (!named.length && !/@theme|:root|^\s*(?:html|body)\s*$/.test(cleanSelector)) continue;
    const targets = named.length ? named.map((t) => overrides[t] ??= {}) : [base];
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
      for (const target of targets) target[name] = value === "initial" ? "" : value;
      if (leading) descriptions.set(name, leading);
      leading = ""; lastName = name; lastEnd = m.index + m[0].length;
    }
  }
  const vars = Object.fromEntries(themes.map((t) => [t, { ...base, ...overrides[t] }]));
  const localNames = new Set([...localCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  const tokens: FoundationToken[] = [...names].map((name) => ({ name, description: descriptions.get(name) ?? "", utility: tokenUtility(name), local: localNames.has(name), values: Object.fromEntries(themes.flatMap((t) => vars[t]![name] ? [[t, vars[t]![name]!]] : [])) })).filter((t) => Object.keys(t.values).length);
  const slotOrder = (name: string) => { const i = COLOR_SLOTS.indexOf(name.slice(8)); return i < 0 ? COLOR_SLOTS.length : i; };
  const colors = tokens.filter((t) => t.name.startsWith("--color-")).sort((a, b) => slotOrder(a.name) - slotOrder(b.name) || a.name.localeCompare(b.name));
  return { themes, vars, colors, type: tokens.filter((t) => /^--(?:font-|text-)/.test(t.name)), spacing: tokens.filter((t) => /^--spacing(?:-|$)/.test(t.name)), radii: tokens.filter((t) => /^--radius(?:-|$)/.test(t.name)), shadows: tokens.filter((t) => /^--shadow(?:-|$)/.test(t.name)) };
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
