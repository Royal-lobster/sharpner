import type { DesignSystem } from "../shared/types";
import { bytesToBase64 } from "./render";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SHEETS = 4;
const sheets = new Map<string, Promise<string>>();
// Google serves the same WOFF2 outlines to current Chrome and the live iframe's browser.
const FONT_USER_AGENT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function fontSheet(href: string) {
  const signal = AbortSignal.timeout(5000);
  const response = await fetch(href, { headers: { "user-agent": FONT_USER_AGENT }, signal });
  if (!response.ok) throw new Error(`Font stylesheet: ${response.status}`);
  const css = await response.text();
  if (css.length > 128_000) throw new Error("Font stylesheet too large");
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]!))];
  let bytes = 0;
  const embedded = new Map<string, string>();
  // Bound upstream concurrency and total bytes for one stylesheet.
  const queue = [...urls];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const font = await fetch(url, { signal });
      if (!font.ok) throw new Error(`Font: ${font.status}`);
      const data = new Uint8Array(await font.arrayBuffer());
      bytes += data.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Font stylesheet exceeds byte budget");
      embedded.set(url, `data:font/woff2;base64,${bytesToBase64(data)}`);
    }
  }));
  return css.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_, url: string) => `url(${embedded.get(url)!})`);
}

/** Design plus embedded @font-face rules, kept out of the Tailwind source so megabytes of font data never reach the compiler. */
export type RenderDesign = DesignSystem & { fonts?: string };

/** Fetch shared public web fonts before launching the paid browser, once per cached stylesheet. */
export async function prepareRenderDesign(design: DesignSystem): Promise<RenderDesign> {
  let tokens = design.tokens;
  const imports = [...tokens.matchAll(/@import\s+(?:url\()?\s*["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)["']?\s*\)?\s*;/g)];
  // A file may import many families. Prepare at most four in parallel; the rest retain links.
  const prepared = await Promise.all(imports.slice(0, MAX_SHEETS).map(async ([declaration, href]) => {
    let sheet = sheets.get(href!);
    if (!sheet) {
      sheet = fontSheet(href!);
      sheets.set(href!, sheet);
      while (sheets.size > MAX_SHEETS) sheets.delete(sheets.keys().next().value!);
      void sheet.catch(() => sheets.delete(href!));
    }
    try { return { declaration, css: await sheet }; }
    catch { return null; } // Keep the original link on transient upstream failures.
  }));
  let fonts = "";
  for (const result of prepared) if (result) { tokens = tokens.replace(result.declaration, ""); fonts += result.css; }
  return fonts ? { ...design, tokens, fonts } : design;
}
