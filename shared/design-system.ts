import { themeNames } from "./themes";
import type { Brand } from "./types";

export const COLOR_SLOTS = ["background", "foreground", "card", "popover", "primary", "primary-foreground", "secondary", "muted", "muted-foreground", "accent", "destructive", "border", "input", "ring", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground", "destructive-foreground"];

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
