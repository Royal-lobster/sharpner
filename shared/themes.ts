/** Theme choices come from token CSS; Light is the default token presentation. */
export function themeNames(css: string): string[] {
  const themes = new Set(["light"]);
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Match literal selectors before quoted strings, so strings containing selector text are skipped.
  const selectors = /\.dark(?![\w-])|\[data-theme\s*=\s*(?:"([^"\\]+)"|'([^'\\]+)'|([\w-]+))\s*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
  for (const match of declarations.matchAll(selectors)) {
    if (match[0].startsWith(".") || match[0].startsWith("[")) themes.add(match[1] ?? match[2] ?? match[3] ?? "dark");
  }
  return [...themes];
}

/** A theme's look in two colors, taken from its token values (named themes override the default). */
export type ThemeSwatch = { background?: string; accent?: string; vars: Record<string, string> };

const SWATCH_BACKGROUND = ["background", "bg", "surface", "canvas", "base", "card"];
const SWATCH_ACCENT = ["primary", "accent", "brand"];

/**
 * Color tokens per theme, for previewing a theme without rendering a screen. Themes can be any
 * named variant, so a swatch comes from the theme's own values rather than from its name.
 * Values stay CSS: `var()` references resolve where the swatch's custom properties are applied.
 */
export function themeSwatches(css: string): Map<string, ThemeSwatch> {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const scopes = new Map<string, Record<string, string>>([["light", {}]]);
  const base: Record<string, string> = {};
  // Innermost blocks only, so wrappers such as @layer or @media still reveal their selectors.
  for (const [, selector, body] of declarations.matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
    const values = Object.fromEntries([...body!.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+)/g)].map(([, name, value]) => [name!, value!.trim()]));
    if (!Object.keys(values).length) continue;
    for (const part of selector!.split(",").map((text) => text.trim())) {
      const named = /\[data-theme\s*=\s*(?:"([^"\\]+)"|'([^'\\]+)'|([\w-]+))\s*\]/.exec(part);
      const theme = named ? named[1] ?? named[2] ?? named[3]! : /\.dark(?![\w-])/.test(part) ? "dark" : /\.light(?![\w-])/.test(part) ? "light"
        : /@theme|:root|^html$|^body$/.test(part) ? null : undefined;
      if (theme === undefined) continue;
      if (theme === null) Object.assign(base, values);
      else scopes.set(theme, { ...scopes.get(theme), ...values });
    }
  }
  const pick = (vars: Record<string, string>, names: string[]) => names.map((name) => `--color-${name}`).find((name) => vars[name]);
  return new Map([...scopes].map(([theme, own]) => {
    const vars = { ...base, ...own };
    // What a theme declares itself is what distinguishes it, even under another token name.
    const background = pick(own, SWATCH_BACKGROUND) ?? pick(vars, SWATCH_BACKGROUND), accent = pick(own, SWATCH_ACCENT) ?? pick(vars, SWATCH_ACCENT);
    return [theme, { vars, background: background && `var(${background})`, accent: accent && `var(${accent})` }];
  }));
}

export const themeLabel = (theme: string) => theme.charAt(0).toUpperCase() + theme.slice(1);

/** null preserves authored HTML at file level, or inherits the file at frame level. */
export function validateTheme(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Theme must be a nonempty name of at most 80 characters, or null");
  }
  return value.trim();
}

/** Foundations always compare all themes; component specimens inherit the file choice unless they define a theme override. */
export function effectiveTheme(node: { kind: string; theme?: string | null }, fileTheme?: string | null): string | undefined {
  if (node.kind === "tokens" || node.kind === "image" || node.kind === "section") return undefined;
  // A component's own theme marks the definition it serves, so its specimen always shows that theme.
  return (node.kind === "frame" || node.kind === "component" ? node.theme ?? fileTheme : fileTheme) ?? undefined;
}

/**
 * Runs inside the rendered document: the theme a component instance renders in, which picks its definition.
 * An applied document theme replaces outer theme contexts (see applyDocumentTheme), so it wins unless the
 * instance sits in a nested context; without one, the nearest authored context decides. "" is the default.
 */
export function componentTheme(element: Element, applied: string | null | undefined): string {
  const selector = "[data-theme],.dark,.light";
  const doc = element.ownerDocument;
  const outer = (e: Element | null | undefined) => !e || e === doc.body || e === doc.documentElement;
  const name = (e: Element) => e.getAttribute("data-theme") || (e.classList.contains("dark") ? "dark" : e.classList.contains("light") ? "light" : "");
  const context = element.parentElement?.closest(selector);
  if (applied != null && (outer(context) || outer(context!.parentElement?.closest(selector)))) return applied;
  return context ? name(context) : "";
}

/** Runs inside the rendered document. Stored HTML stays unchanged. */
function applyDocumentTheme(theme: string) {
  // Announced before parsing finishes, so component expansion can pick this theme's definitions.
  (window as unknown as { __sharpnerTheme?: string }).__sharpnerTheme = theme;
  const selector = "[data-theme],.dark,.light";
  const apply = () => {
    // Authored screens may put their theme on wrappers rather than <html>, including separate
    // header and content roots. Replace each outer context; leave nested theme markup alone.
    const contexts = [...document.body.querySelectorAll<HTMLElement>(selector)].filter((element) => {
      const parent = element.parentElement?.closest(selector);
      return !parent || parent === document.body || parent === document.documentElement;
    });
    const roots = [document.documentElement, document.body, ...contexts];
    for (const root of roots) {
      root.dataset.theme = theme;
      root.classList.remove("dark", "light");
      if (theme === "dark" || theme === "light") root.classList.add(theme);
    }
    document.documentElement.style.colorScheme = theme === "light" ? "light" : theme === "dark" ? "dark" : "normal";
  };
  // Component expansion also waits for parsing; registering after it includes authored component roots.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
}

export function documentThemeScript(theme?: string | null): string {
  if (theme == null) return "";
  const value = JSON.stringify(theme).replace(/</g, "\\u003c");
  return `<script>(${applyDocumentTheme.toString()})(${value})</script>`;
}
