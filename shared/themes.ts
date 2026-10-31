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

export const themeLabel = (theme: string) => theme.charAt(0).toUpperCase() + theme.slice(1);

/** null preserves authored HTML at file level, or inherits the file at frame level. */
export function validateTheme(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Theme must be a nonempty name of at most 80 characters, or null");
  }
  return value.trim();
}

/** Foundations always compare all themes; component specimens inherit the file choice. */
export function effectiveTheme(node: { kind: string; theme?: string | null }, fileTheme?: string | null): string | undefined {
  if (node.kind === "tokens" || node.kind === "image" || node.kind === "section") return undefined;
  return (node.kind === "frame" ? node.theme ?? fileTheme : fileTheme) ?? undefined;
}

/** Runs inside the rendered document. Stored HTML stays unchanged. */
function applyDocumentTheme(theme: string) {
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
