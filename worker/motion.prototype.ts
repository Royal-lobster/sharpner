// THROWAWAY: compile the synthetic fixture once outside the browser. Auth remains in index.ts.
import { thumbnailCss } from "./thumbnail-css";
import { frameDocument, type DesignSystem } from "../shared/types";
export async function motionPrototypeCss(input: { design: DesignSystem; html: string }) {
  const started = performance.now();
  const doc = frameDocument(input.html, { design: input.design, compiledTailwind: true });
  const source = [...doc.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join("\n");
  const candidates = [...new Set([...doc.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap(m => (m[1] ?? m[2] ?? m[3]!).split(/\s+/)))];
  const css = await thumbnailCss(source, candidates);
  return { css, ms: performance.now() - started };
}
