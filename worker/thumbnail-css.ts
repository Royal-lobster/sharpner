import { compile } from "tailwindcss";
import index from "tailwindcss/index.css?raw";
import preflight from "tailwindcss/preflight.css?raw";
import theme from "tailwindcss/theme.css?raw";
import utilities from "tailwindcss/utilities.css?raw";

const styles: Record<string, string> = { index, preflight, theme, utilities };
const cache = new Map<string, { compiler: ReturnType<typeof compile>; candidates: Set<string> }>();
const MAX_COMPILERS = 4;
const MAX_CANDIDATES = 20_000;
const MAX_CSS_BYTES = 2_000_000;

/** Same compiler, imports and DOM class collection as @tailwindcss/browser, outside the paid browser. */
export async function thumbnailCss(input: string, candidates: string[]): Promise<string> {
  // Match the browser build's implicit import rule, including authored text/tailwindcss styles.
  const source = input.includes("@import") ? input : `@import "tailwindcss";${input}`;
  let entry = cache.get(source);
  if (entry && entry.candidates.size + candidates.length > MAX_CANDIDATES) { cache.delete(source); entry = undefined; }
  if (!entry) {
    const compiler = compile(source, {
      base: "/",
      loadStylesheet: async (id, base) => {
        const name = id.replace(/^tailwindcss\/?/, "").replace(/^\.\//, "").replace(/\.css$/, "") || "index";
        if (!(name in styles)) throw new Error(`The browser build does not support @import for "${id}"`);
        return { path: `virtual:tailwindcss/${name}.css`, base, content: styles[name]! };
      },
      loadModule: async () => { throw new Error("The browser build does not support plugins or config files."); },
    });
    entry = { compiler, candidates: new Set() };
    if (source.length <= MAX_CSS_BYTES && candidates.length <= MAX_CANDIDATES) {
      cache.set(source, entry);
      while (cache.size > MAX_COMPILERS || [...cache.keys()].reduce((n, key) => n + key.length, 0) > MAX_CSS_BYTES) cache.delete(cache.keys().next().value!);
      void compiler.catch(() => cache.delete(source));
    }
  } else { cache.delete(source); cache.set(source, entry); }
  const compiler = await entry.compiler;
  for (const candidate of candidates) entry.candidates.add(candidate);
  return compiler.build(candidates);
}
