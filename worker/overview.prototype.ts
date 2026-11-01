// THROWAWAY: local authenticated experiment preparation, never a shipping endpoint.
import { thumbnailCss } from "./thumbnail-css";
import { prepareRenderDesign } from "./render-fonts";
import { frameDocument, type DesignSystem } from "../shared/types";
export const overviewSheets = new Map<string,string>();
export async function prepareOverview(design:DesignSystem,html:string[]){
  const start=performance.now(),prepared=await prepareRenderDesign(design);
  // Do not copy embedded font bytes once per screen (300 copies can exceed Worker memory).
  const documents=[frameDocument(html[0]??"",{design:prepared,compiledTailwind:true}),...html];
  const source=[...new Set(documents.flatMap(doc=>[...doc.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]!)))].join("\n");
  const candidates=[...new Set([...html,...design.components.map(c=>c.html)].flatMap(doc=>[...doc.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap(m=>(m[1]??m[2]??m[3]!).split(/\s+/))))];
  const css=await thumbnailCss(source,candidates),key=crypto.randomUUID();
  overviewSheets.set(key,css);while(overviewSheets.size>4)overviewSheets.delete(overviewSheets.keys().next().value!);
  return {css,cssUrl:`/api/overview-prototype-css/${key}`,ms:performance.now()-start,design:{...design,tokens:design.tokens.replace(/@import\s+(?:url\()?\s*["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)["']?\s*\)?\s*;/g,"")}};
}
