import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneFontFaces } from "./render-fonts";
import { aliasSystemFonts } from "./render";
afterEach(()=>vi.unstubAllGlobals());
describe("shared web-font preparation",()=>{
  // The stand-in system font is fetched once per isolate; each test starts without it.
  let prepareRenderDesign: typeof import("./render-fonts").prepareRenderDesign;
  beforeEach(async()=>{vi.resetModules();({prepareRenderDesign}=await import("./render-fonts"));});
  const sheet=(family:string,file:string)=>`@font-face {font-family:${family}; font-weight:100 900; src:url(https://fonts.gstatic.com/${file}.woff2) format("woff2");}`;
  it("fetches stylesheet and font bytes once, before paid browser work, preserving font-face descriptors",async()=>{
    const fetcher = vi.fn(async(url:string)=>new Response(url.includes("googleapis")?sheet("Inter","test"):new Uint8Array([1,2,3])));
    vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Inter-test"); @theme {--font-sans:Inter}',components:[]};
    const prepared=await prepareRenderDesign(design);
    expect(prepared.fonts).toContain("data:font/woff2;base64,AQID");
    expect(prepared.fonts).toContain("font-family:Inter; font-weight:100 900");
    // Font bytes stay out of the Tailwind source, and the remote link is no longer needed.
    expect(prepared.tokens).toBe(' @theme {--font-sans:Inter}');
    expect(await prepareRenderDesign(design)).toEqual(prepared);
    // Two for the imported family, two for the stand-in system font.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("leaves other providers alone and falls back to the original font link on upstream failure",async()=>{
    const fetcher=vi.fn(async()=>new Response("unavailable",{status:503}));vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Fallback-test"); @import url("https://other.example/fonts.css");',components:[]};
    expect(await prepareRenderDesign(design)).toBe(design);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("embeds a stand-in for system fonts under a family @font-face may claim, for a design that imports no font",async()=>{
    const fetcher=vi.fn(async(url:string)=>new Response(url.includes("googleapis")?sheet("'Inter'","system"):new Uint8Array([1,2,3])));
    vi.stubGlobal("fetch",fetcher);
    const design={tokens:"@theme {--font-sans:system-ui, sans-serif}",components:[]};
    const prepared=await prepareRenderDesign(design);
    expect(prepared.fonts).toBe('@font-face {font-family: ui-sans-serif; font-weight:100 900; src:url(data:font/woff2;base64,AQID) format("woff2");}');
    expect(prepared.tokens).toBe(design.tokens);
  });
});

describe("system font stacks in compiled CSS",()=>{
  it("names the stand-in before each system family @font-face cannot claim",()=>{
    expect(aliasSystemFonts(":root{--font-sans:system-ui, sans-serif}")).toBe(":root{--font-sans:ui-sans-serif,system-ui, sans-serif}");
    expect(aliasSystemFonts("p{font-family:-apple-system,BlinkMacSystemFont,Roboto}")).toBe("p{font-family:ui-sans-serif,-apple-system,ui-sans-serif,BlinkMacSystemFont,Roboto}");
  });
  it("leaves selectors, quoted names and URLs as written",()=>{
    const css='.system-ui,[data-font=system-ui],#system-ui{font-family:"system-ui"}@font-face{font-family:Own;src:url(/fonts/system-ui.woff2),url(system-ui.woff),url(https://x.example/-apple-system/a.woff)}';
    expect(aliasSystemFonts(css)).toBe(css);
    expect(aliasSystemFonts("p{font:15px/1.2 system-ui;font-family:var(--stack,system-ui)}")).toBe("p{font:15px/1.2 ui-sans-serif,system-ui;font-family:var(--stack,ui-sans-serif,system-ui)}");
  });
  it("leaves class selectors and longer names as written",()=>{
    const css=".font-\\[system-ui\\]{font-family:system-ui}.md\\:font-\\[Inter\\,system-ui\\]{font:-apple-system-body}";
    expect(aliasSystemFonts(css)).toBe(css.replace("font-family:system-ui","font-family:ui-sans-serif,system-ui"));
  });
});

describe("font subsets for a sprite", () => {
  const face = (subset: string, range?: string) => `/* ${subset} */\n@font-face {\n  font-family: 'Inter';\n  src: url(data:font/woff2;base64,${subset}) format('woff2');${range ? `\n  unicode-range: ${range};` : ""}\n}\n`;
  const sheet = face("latin", "U+0000-00FF, U+0131, U+2000-206F, U+20AC") + face("cyrillic", "U+0301, U+0400-045F, U+0490-0491") + face("greek", "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF") + face("vietnamese", "U+1EA0-1EF9, U+20AB") + face("variable");
  const kept = (text: string) => [...pruneFontFaces(sheet, text).matchAll(/base64,(\w+)/g)].map((m) => m[1]);
  it("keeps only the subsets whose ranges cover the documents' characters, and faces without a range", async () => {
    expect(kept("<p class=\"p-4\">Hello – €12</p>")).toEqual(["latin", "variable"]);
    expect(kept("<p>Привет and Ελληνικά</p>")).toEqual(["latin", "cyrillic", "greek", "variable"]);
    expect(kept("Tiếng Việt")).toEqual(["latin", "vietnamese", "variable"]);
  });
  it("reads single code points and wildcard ranges", async () => {
    expect([...pruneFontFaces(face("one", "U+0131") + face("wild", "U+4??"), "ı").matchAll(/base64,(\w+)/g)].map((m) => m[1])).toEqual(["one"]);
    expect([...pruneFontFaces(face("one", "U+0131") + face("wild", "U+4??"), "ѐ").matchAll(/base64,(\w+)/g)].map((m) => m[1])).toEqual(["wild"]);
  });
});
