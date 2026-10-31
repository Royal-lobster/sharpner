// THROWAWAY PROTOTYPE: local-only compiled stylesheet preparation for canvas experiments.
import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { thumbnailCss } from "./thumbnail-css";
import { prepareRenderDesign } from "./render-fonts";
import { frameDocument, type DesignSystem } from "../shared/types";
const sheets = new Map<string,string>();
export const renderPrototype = new Hono<AppEnv>();
renderPrototype.use(async(c,next)=>{if(!(import.meta.env.DEV || import.meta.env.VITE_RENDER_EXPERIMENT==="1") || new URL(c.req.url).hostname!=="localhost") return c.notFound();await next();});
renderPrototype.post("/css",async(c)=>{
  const input=await c.req.json<{design:DesignSystem;html:string[]}>();
  const design=await prepareRenderDesign(input.design);
  const documents=input.html.map(html=>frameDocument(html,{design,compiledTailwind:true}));
  const source=[...new Set(documents.flatMap(doc=>[...doc.matchAll(/<style\b[^>]*type=["']text\/tailwindcss["'][^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1])))].join("\n");
  const sources=[...input.html,...input.design.components.map(c=>c.html)].join("\n");
  const classes=[...new Set([...sources.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap(m=>(m[1]??m[2]??m[3]!).split(/\s+/)))];
  const css=await thumbnailCss(source,classes);
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(css));
  const key=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
  sheets.set(key,css);while(sheets.size>4)sheets.delete(sheets.keys().next().value!);
  const renderDesign={...input.design,tokens:input.design.tokens.replace(/@import\s+(?:url\()?\s*["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)["']?\s*\)?\s*;/g,declaration=>design.tokens.includes(declaration)?declaration:"")};
  return c.json({css,cssUrl:`/api/render-prototype/css/${key}.css`,design:renderDesign});
});
renderPrototype.get("/css/:key",c=>{
  const css=sheets.get(c.req.param("key").replace(/\.css$/,""));
  return css===undefined?c.notFound():c.body(css,200,{"content-type":"text/css","cache-control":"public,max-age=31536000,immutable"});
});
