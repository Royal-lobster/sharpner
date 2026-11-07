import { themeLabel, themeNames } from "./themes";
import type { Brand } from "./types";

/** shadcn/ui's v4 theme colours, the slots a token sheet shows first: the core roles, five chart series and the sidebar. */
export const COLOR_SLOT_GROUPS = {
  base: ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground", "border", "input", "ring"],
  chart: ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"],
  sidebar: ["sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"],
} as const;
export const COLOR_SLOTS: string[] = Object.values(COLOR_SLOT_GROUPS).flat();

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
  for (const [prefix, utility] of [["font-weight-", "font-"], ["font-", "font-"], ["text-", "text-"], ["radius-", "rounded-"], ["shadow-", "shadow-"], ["inset-shadow-", "inset-shadow-"], ["tracking-", "tracking-"], ["leading-", "leading-"], ["ease-", "ease-"], ["animate-", "animate-"], ["spacing-", "p-"]]) if (name.startsWith(`--${prefix}`)) return utility + name.slice(prefix!.length + 2);
  return name === "--spacing" ? "p-1" : name === "--radius" ? "rounded" : name === "--shadow" ? "shadow" : `var(${name})`;
}

/** Only unconditional root/theme rules describe file-wide foundations. Scoped/conditional CSS stays in live previews. */
function tokenRules(css: string) {
  const rules: { selector: string; body: string }[] = [];
  // Each open block keeps its own text, without nested blocks: a `@theme` that also holds `@keyframes` still
  // declares its tokens.
  const stack: { selector: string; parts: string[]; from: number; excluded: boolean }[] = [];
  let header = 0;
  // Skip strings and comments when finding blocks, including braces in token strings and URLs.
  for (const m of css.matchAll(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]/g)) {
    if (m[0] === "{") {
      const selector = css.slice(header, m.index).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      const parent = stack.at(-1);
      // The nested block's selector stays in the parent's text, so a comment just before it still describes a token.
      if (parent) parent.parts.push(css.slice(parent.from, m.index));
      stack.push({ selector, parts: [], from: m.index + 1, excluded: !!parent && (parent.excluded || !/^@layer\b/.test(parent.selector)) });
      header = m.index + 1;
    } else if (m[0] === "}") {
      const block = stack.pop();
      if (block && !block.excluded) rules.push({ selector: block.selector, body: block.parts.join("") + css.slice(block.from, m.index) });
      const parent = stack.at(-1);
      if (parent) parent.from = m.index + 1;
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
  return { themes, vars, tokens, colors, type: tokens.filter((t) => /^--(?:font-|text-)/.test(t.name)), spacing: tokens.filter((t) => /^--spacing(?:-|$)/.test(t.name)), radii: tokens.filter((t) => /^--radius(?:-|$)/.test(t.name)), shadows: tokens.filter((t) => /^--shadow(?:-|$)/.test(t.name)) };
}

/**
 * A column of a token sheet: one distinct theme, as a screen root in it sees the tokens. `key` is the theme the
 * values come from ("" for the root default); `names` are every theme with exactly these values.
 */
export type SheetColumn = { key: string; names: string[]; label: string; scheme: "dark" | "light" | null; vars: Record<string, string> };

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const declaresTheme = (css: string, theme: string) => new RegExp(String.raw`\.${theme}(?![\w-])|\[data-theme\s*=\s*["']?${theme}["']?\s*\]`).test(css);

/**
 * The themes a token sheet compares, as columns. A sheet that declares a light alternative and no dark one, like
 * tupredices' `:root` with `.light`, is dark at its root; otherwise the root is Light, as in shadcn's `:root` with
 * `.dark`. Themes whose values are identical share one column, named after all of them. Dark comes first, then
 * Light, then the other themes in declaration order.
 */
export function sheetColumns(css: string): SheetColumn[] {
  const plain = stripComments(css);
  const rootDark = declaresTheme(plain, "light") && !declaresTheme(plain, "dark");
  const keys = rootDark ? ["", ...themeNames(css)] : themeNames(css);
  const { vars } = foundations(css, css, keys);
  const groups: string[][] = [];
  const signature = (key: string) => JSON.stringify(Object.entries(vars[key]!).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)));
  for (const key of keys) {
    const same = groups.find((group) => signature(group[0]!) === signature(key));
    if (same) same.push(key); else groups.push([key]);
  }
  const named = (key: string) => key || "dark";
  const columns = groups.map((group): SheetColumn => {
    const names = [...new Set(group.map(named))];
    const scheme = names.includes("dark") ? "dark" : names.includes("light") ? "light" : null;
    return { key: group[0]!, names, label: names.map(themeLabel).join(" · "), scheme, vars: vars[group[0]!]! };
  });
  const rank = (column: SheetColumn) => column.scheme === "dark" ? 0 : column.scheme === "light" ? 1 : 2;
  return columns.map((column, i) => ({ column, i })).sort((a, b) => rank(a.column) - rank(b.column) || a.i - b.i).map(({ column }) => column);
}

/** Substitutes `var()` references with the column's own values, so equal decisions compare equal. */
export function resolveToken(value: string, vars: Record<string, string>): string {
  let out = value;
  for (let depth = 0; depth < 12 && out.includes("var("); depth++) {
    const next = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (m, name: string, fallback?: string) =>
      vars[name] ? vars[name]! : fallback !== undefined ? fallback.trim() : m);
    if (next === out) break;
    out = next;
  }
  return out.toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1").trim();
}

/** A colour on the sheet. Paired with its `-foreground`, it shows "Aa" in that colour and the contrast in each theme. */
export type SheetColor = { name: string; token: FoundationToken | null; foreground: string | null; foregroundToken: FoundationToken | null; same: string[] };
export type SheetColorGroup = { name: string; items: SheetColor[] };
export type SheetRamp = { name: string; steps: { step: number; name: string }[] };
export type SheetTextSize = { token: FoundationToken; lineHeight: FoundationToken | null; px: number | null; display: boolean };
export type SheetEase = { token: FoundationToken; curve: [number, number, number, number] | null };

/** Milliseconds of a CSS time, or null. */
export function durationMs(value: string) {
  const m = /^(-?\d*\.?\d+)(ms|s)$/i.exec(value.trim());
  return m ? Number(m[1]) * (m[2]!.toLowerCase() === "s" ? 1000 : 1) : null;
}

const EASE_KEYWORDS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], "ease-in": [0.42, 0, 1, 1], "ease-out": [0, 0, 0.58, 1], "ease-in-out": [0.42, 0, 0.58, 1],
};
/** The cubic Bézier control points of a CSS easing function, mapping the keywords; null for steps() and linear(). */
export function easeCurve(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  if (EASE_KEYWORDS[v]) return EASE_KEYWORDS[v]!;
  const m = /^cubic-bezier\(\s*([^)]*)\)$/.exec(v);
  const points = m?.[1]!.split(",").map((n) => Number(n.trim()));
  return points?.length === 4 && points.every(Number.isFinite) ? points as [number, number, number, number] : null;
}

/** Pixels of a declared length in px, rem or em (16px root), or null. */
export function lengthPx(value: string) {
  const m = /^(-?\d*\.?\d+)(px|rem|em)$/i.exec(value.trim());
  return m ? Number(m[1]) * (m[2]!.toLowerCase() === "px" ? 1 : 16) : null;
}

const COLOR_VALUE = /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(.*\)|(?!none|auto|inherit|initial|unset|normal|currentcolor)[a-z]+)$/i;
/** Multiples of `--spacing` the sheet draws, the steps a layout uses most. */
export const SPACING_STEPS = [1, 2, 3, 4, 6, 8, 12, 16];

/**
 * Everything a token sheet shows, read from its CSS. Colours put shadcn's slots first, with the ones the sheet does
 * not declare flagged, then the product's additions grouped by their first name segment. Palette ramps are other
 * custom properties in families of five or more numbered colour steps.
 */
export function tokenSheet(css: string) {
  const columns = sheetColumns(css);
  const { tokens } = foundations(css, css, columns.length ? columns.map((c) => c.key) : undefined);
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const token = (name: string) => byName.get(name) ?? null;
  const resolved = (name: string) => columns.map((c) => c.vars[name] ? resolveToken(c.vars[name]!, c.vars) : "");
  const color = (name: string) => token(`--color-${name}`);
  const colorNames = tokens.filter((t) => t.name.startsWith("--color-")).map((t) => t.name.slice(8));
  const slotSet = new Set(COLOR_SLOTS);
  const item = (name: string, foreground: string | null): SheetColor => ({ name, token: color(name), foreground, foregroundToken: foreground ? color(foreground) : null, same: [] });
  const slots = Object.entries(COLOR_SLOT_GROUPS).map(([group, names]) => ({
    name: group as keyof typeof COLOR_SLOT_GROUPS,
    items: names.filter((name) => !(name.endsWith("-foreground") && slotSet.has(name.slice(0, -11)))).map((name) => item(name, slotSet.has(`${name}-foreground`) ? `${name}-foreground` : null)),
  }));
  const extra = colorNames.filter((name) => !slotSet.has(name));
  const extraSet = new Set(extra);
  const paired = new Set(extra.filter((name) => name.endsWith("-foreground") && extraSet.has(name.slice(0, -11))));
  const additions: SheetColorGroup[] = [];
  const declaredSlots = COLOR_SLOTS.filter((name) => color(name)).map((name) => ({ name, values: resolved(`--color-${name}`) }));
  for (const name of extra.filter((name) => !paired.has(name))) {
    const entry = item(name, extraSet.has(`${name}-foreground`) ? `${name}-foreground` : null);
    const values = resolved(`--color-${name}`);
    entry.same = declaredSlots.filter((slot) => slot.values.every((v, i) => v && v === values[i])).map((slot) => slot.name);
    const group = name.split("-")[0]!;
    const existing = additions.find((g) => g.name === group);
    if (existing) existing.items.push(entry); else additions.push({ name: group, items: [entry] });
  }
  const families = new Map<string, { step: number; name: string }[]>();
  for (const t of tokens) {
    const m = /^--([a-z][\w-]*?)-(\d+)$/i.exec(t.name);
    if (!m || t.name.startsWith("--color-")) continue;
    families.set(m[1]!, [...families.get(m[1]!) ?? [], { step: Number(m[2]), name: t.name }]);
  }
  const ramps: SheetRamp[] = [...families].filter(([family, steps]) => steps.length >= 5
      && !steps.some((s) => byName.has(`--color-${family}-${s.step}`))
      && steps.every((s) => resolved(s.name).some((v) => COLOR_VALUE.test(v))))
    .map(([name, steps]) => ({ name, steps: steps.sort((a, b) => a.step - b.step) }));
  const own = (pattern: RegExp) => tokens.filter((t) => pattern.test(t.name) && !t.name.slice(2).includes("--"));
  const first = (name: string) => resolved(name).find(Boolean) ?? "";
  const hasDisplay = byName.has("--font-display");
  const text = own(/^--text-(?!icon(?:-|$))/).map((t): SheetTextSize => {
    const px = lengthPx(first(t.name));
    const step = /^--text-(\d+)xl$/.exec(t.name)?.[1];
    return { token: t, lineHeight: token(`${t.name}--line-height`), px, display: hasDisplay && ((px ?? 0) >= 24 || Number(step ?? 0) >= 2) };
  }).map((size, i) => ({ size, i })).sort((a, b) => (b.size.px ?? -1) - (a.size.px ?? -1) || a.i - b.i).map(({ size }) => size);
  return {
    columns, tokens,
    color: { slots, additions, declared: COLOR_SLOTS.filter((name) => color(name)).length, extra: extra.length },
    ramps,
    fonts: own(/^--font-(?!weight-)/),
    weights: own(/^--font-weight-/),
    tracking: own(/^--tracking-/),
    text,
    icons: own(/^--text-icon(?:-|$)/),
    spacing: { base: token("--spacing"), steps: SPACING_STEPS, named: own(/^--spacing-/) },
    radii: own(/^--radius(?:-|$)/),
    shadows: own(/^--(?:inset-)?shadow(?:-|$)/),
    motion: {
      durations: own(/^--duration-/).map((t) => ({ token: t, ms: durationMs(first(t.name)) })),
      eases: own(/^--ease-/).map((t): SheetEase => ({ token: t, curve: easeCurve(first(t.name)) })),
      animations: own(/^--animate-/),
    },
  };
}
export type TokenSheet = ReturnType<typeof tokenSheet>;
