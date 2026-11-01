import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRenderDesign } from "./render-fonts";
afterEach(()=>vi.unstubAllGlobals());
describe("shared web-font preparation",()=>{
  it("fetches stylesheet and font bytes once, before paid browser work, preserving font-face descriptors",async()=>{
    const fetcher = vi.fn(async(url:string)=>new Response(url.includes("googleapis")?'@font-face {font-family:Inter; font-weight:100 900; src:url(https://fonts.gstatic.com/test.woff2) format("woff2");}':new Uint8Array([1,2,3])));
    vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Inter-test"); @theme {--font-sans:Inter}',components:[]};
    const prepared=await prepareRenderDesign(design);
    expect(prepared.fonts).toContain("data:font/woff2;base64,AQID");
    expect(prepared.fonts).toContain("font-weight:100 900");
    // Font bytes stay out of the Tailwind source, and the remote link is no longer needed.
    expect(prepared.tokens).toBe(' @theme {--font-sans:Inter}');
    expect(await prepareRenderDesign(design)).toEqual(prepared);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("leaves other providers alone and falls back to the original font link on upstream failure",async()=>{
    const fetcher=vi.fn(async()=>new Response("unavailable",{status:503}));vi.stubGlobal("fetch",fetcher);
    const design={tokens:'@import url("https://fonts.googleapis.com/css2?family=Fallback-test"); @import url("https://other.example/fonts.css");',components:[]};
    expect(await prepareRenderDesign(design)).toBe(design);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
