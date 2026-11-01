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
