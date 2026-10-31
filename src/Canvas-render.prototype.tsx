// THROWAWAY PROTOTYPE: five renderers on the existing editor route (?prototype=render&variant=...).
// Changes and clone density are in memory; this route never writes fixture edits into a shared file.
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Canvas } from "./Canvas";
import { frameDocument, type CanvasNode } from "../shared/types";
import { effectiveTheme } from "../shared/themes";
import { ThumbnailCache, thumbnailSource } from "./thumbnail-cache";
import { PreviewLoader } from "./preview-loader";
import { paintRaster } from "./Canvas";
import type { PrototypeFrame, PrototypeSurface } from "./frame-surface.prototype";

type Props=ComponentProps<typeof Canvas>;
type Sample={variant:string;count:number;theme:string|null;edit:number;elapsedMs:number;navigationMs:number;supported:number;unsupported:number;reasons:string[];domNodes:number;iframes:number;heapBytes:number|null;resourceBytes:number};
type Probe={ready:boolean;results:Sample[];update:(theme:string|null,edit?:number)=>Promise<Sample>;motion:(ms?:number)=>Promise<unknown>;inspect:()=>unknown};
declare global{interface Window{__sharpnerPrototype?:Probe}}
const variants=["raster","fresh","persistent","shadow","svg"];
function mountFresh(host:HTMLElement):PrototypeSurface{
  let iframe:HTMLIFrameElement|null=null;
  return {async update(f){
    const next=document.createElement("iframe");next.sandbox.add("allow-scripts");
    next.style.cssText=`border:0;display:block;width:${f.width}px;height:${f.height??1000}px;pointer-events:none`;
    const token=crypto.randomUUID();
    const loaded=new Promise<{height:number;domNodes:number}>(resolve=>{
      const listener=(event:MessageEvent)=>{if(event.source!==next.contentWindow||event.data?.prototypeFresh!==token)return;removeEventListener("message",listener);resolve(event.data);};
      addEventListener("message",listener);
    });
    const ack=`<script>addEventListener("load",async()=>{await document.fonts.ready;parent.postMessage({prototypeFresh:${JSON.stringify(token)},height:Math.ceil(document.body.getBoundingClientRect().height),domNodes:document.querySelectorAll("*").length},"*")})<\/script>`;
    next.srcdoc=frameDocument(f.html,{base:location.origin,design:f.design,theme:f.theme,compiledTailwind:true,tailwindCss:f.css})+ack;
    host.appendChild(next);const result=await loaded;
    const measuredHeight=result.height;
    iframe?.remove();iframe=next;
    return {measuredHeight,supported:true,domNodes:result.domNodes};
  },dispose(){iframe?.remove();}};
}
async function factory(variant:string,host:HTMLElement):Promise<PrototypeSurface>{
  if(variant==="persistent")return (await import("./persistent-frame.prototype")).mountPersistentFrame(host);
  if(variant==="shadow")return (await import("./shadow-frame.prototype")).mountShadowFrame(host);
  if(variant==="svg")return (await import("./svg-frame.prototype")).mountSvgFrame(host);
  return mountFresh(host);
}
const timeout=<T,>(promise:Promise<T>,ms:number)=>Promise.race([promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error(`Prototype timed out after ${ms}ms`)),ms))]);

export function CanvasRenderPrototype(props:Props){
  const {room,pageId}=props;
  useSyncExternalStore(room.subscribe,room.getVersion);
  const params=new URLSearchParams(location.search),variant=params.get("variant")??"raster";
  const count=Math.max(1,Math.min(300,Number(params.get("count")??40)));
  const caseName=params.get("case")??"actual";
  const root=useRef<HTMLDivElement>(null),world=useRef<HTMLDivElement>(null),raster=useRef<HTMLCanvasElement>(null);
  const [status,setStatus]=useState("Loading real file sources…");
  const seedNodes=[...room.nodes.values()].filter(n=>n.pageId===pageId&&n.kind==="frame").slice(0,Math.min(count,40));
  const ids=seedNodes.map(n=>n.id).join(",");
  useEffect(()=>{room.needSources(variant==="raster"?[]:ids.split(",").filter(Boolean));return()=>room.needSources([]);},[room,ids,variant]);
  const loaded=seedNodes.length>0&&(variant==="raster"||seedNodes.every(n=>room.sources.get(n.id)?.rev===n.rev));
  const design=room.design();
  const sourceKey=loaded?seedNodes.map(n=>room.sources.get(n.id)?.source??"").join("\u0000"):"";
  useEffect(()=>{
    if(!loaded||!root.current||!world.current||!raster.current)return;
    let disposed=false;
    const hosts:HTMLElement[]=[],surfaces:PrototypeSurface[]=[];
    let theme:string|null=params.get("theme")??room.fileTheme, edit=0;
    const samples:Sample[]=[];
    const area=root.current,layer=world.current,canvas=raster.current;
    const columns=Math.ceil(Math.sqrt(count*1.5)),cellW=1280,cellH=1080;
    const nodes:CanvasNode[]=Array.from({length:count},(_,i)=>({...seedNodes[i%seedNodes.length]!,id:`prototype-${i}`,name:`Screen ${i+1}`,x:(i%columns)*cellW,y:Math.floor(i/columns)*cellH,width:1200,height:1000}));
    const rects=new Map(nodes.map(n=>[n.id,{x:n.x,y:n.y,w:n.width,h:n.height??1000}]));
    const size={w:area.clientWidth,h:area.clientHeight};
    const z=Math.min((size.w-80)/(columns*cellW-80),(size.h-160)/(Math.ceil(count/columns)*cellH-80));
    const camera={z,x:40,y:80};
    layer.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.z})`;
    const loader=new PreviewLoader();
    const paint=()=>{
      if(disposed||variant!=="raster")return;
      const projected=nodes.map(n=>({node:n,rect:rects.get(n.id)!,screenWidth:n.width*z,visibleArea:n.width*(n.height??1000)*z*z}));
      paintRaster(canvas,size,camera,[],projected,new Set(),new Map(),new Set(),[],{agent:new Map(),done:new Map(),appeared:new Map(),now:performance.now(),reducedMotion:true},cache);
    };
    const cache=new ThumbnailCache(()=>requestAnimationFrame(paint),{loadImage:loader.load,prepareImages:loader.prepare});
    const experimentalDesign={...design,components:[...design.components]};
    if(caseName==="variants"){
      experimentalDesign.components=experimentalDesign.components.filter(c=>!(c.tag==="x-button"&&c.theme==="dark"));
      experimentalDesign.components.push({tag:"x-button",theme:"dark",html:'<button class="rounded-full bg-primary px-6 py-3 font-bold text-foreground"><span aria-hidden="true">✦ </span><strong>{{label|Continue}}</strong><span> →</span></button>'});
      experimentalDesign.tokens+='\n[data-theme="dark"] {--font-sans:Georgia,serif;--radius-xl:2rem}';
    }
    const fidelityHtml=`<!doctype html><html class="authored-root dark" data-theme="dark" style="font-size:20px"><head><style>
html,body{height:100%;background:var(--color-background);color:var(--color-foreground)}
body{font-family:var(--font-sans);padding:24px}.viewport{width:50vw;height:10vh;background:var(--color-primary);border-radius:1rem}.responsive::after{content:"narrow"}@media(min-width:1000px){.responsive::after{content:"wide"}}.card{padding:1rem;border:2px solid var(--color-primary);margin:16px 0}.pseudo::before{content:"★ ";color:var(--color-primary)}
</style></head><body class="authored-body"><header><h1 class="text-3xl font-bold">Analytics fidelity</h1><div class="responsive"></div></header><div class="viewport"></div><main class="dark" data-theme="dark"><section class="card"><h2 class="pseudo">Outer theme</h2><x-button label="Outer button"></x-button></section><section class="card light" data-theme="light"><h2>Nested light</h2><x-button label="Nested button"></x-button></section></main><img src="/mark.svg" width="96" height="96"><svg width="160" height="80" viewBox="0 0 160 80"><defs><linearGradient id="g"><stop stop-color="#f80"/><stop offset="1" stop-color="#08f"/></linearGradient></defs><rect x="4" y="4" width="150" height="70" rx="20" fill="url(#g)"/></svg></body></html>`;
    const denseHtml=`<main class="bg-background text-foreground font-sans min-h-screen p-6"><h1 class="text-3xl font-bold">Analytics dense</h1><div class="grid grid-cols-6 gap-3">${Array.from({length:150},(_,i)=>`<article class="rounded-xl border border-border p-2"><div class="flex items-center gap-2"><span class="rounded-full bg-primary p-1">${i}</span><strong>Account ${i}</strong></div><div class="text-xs opacity-60">Monthly activity</div><div class="text-lg font-bold">$${i*137}</div><div class="h-2 rounded bg-primary my-2"></div><x-button label="View"></x-button></article>`).join("")}</div></main>`;
    const inputs=nodes.map((n,i)=>({node:n,html:caseName==="fidelity"?fidelityHtml:caseName==="dense"?denseHtml:room.sources.get(seedNodes[i%seedNodes.length]!.id)?.source??""}));
    const inspect=()=>({variant,count,theme,edit,domNodes:document.querySelectorAll("*").length,iframes:document.querySelectorAll("iframe").length,heapBytes:(performance as Performance&{memory?:{usedJSHeapSize:number}}).memory?.usedJSHeapSize??null});
    const probe:Probe={ready:false,results:samples,update:async()=>{throw new Error("Not initialized");},inspect,motion:async(ms=1500)=>{
      const deltas:number[]=[];let last=performance.now(),start=last;
      await new Promise<void>(resolve=>requestAnimationFrame(function tick(now){deltas.push(now-last);last=now;camera.x=40+Math.sin((now-start)/180)*120;camera.y=80+Math.cos((now-start)/230)*60;
        layer.style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.z})`;paint();
        if(now-start<ms)requestAnimationFrame(tick);else resolve();}));
      camera.x=40;camera.y=80;layer.style.transform=`translate(40px,80px) scale(${camera.z})`;paint();
      const sorted=[...deltas].sort((a,b)=>a-b);return{frames:deltas.length,elapsedMs:last-start,meanFrameMs:deltas.reduce((a,b)=>a+b,0)/deltas.length,p95FrameMs:sorted[Math.floor(sorted.length*.95)],maxFrameMs:Math.max(...deltas),...inspect()};
    }};
    window.__sharpnerPrototype=probe;
    void(async()=>{
      const start=performance.now();
      let css:{css:string;cssUrl?:string;design?:typeof experimentalDesign}={css:""};
      if(variant!=="raster"){
        const response=await fetch("/api/render-prototype/css",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({design:experimentalDesign,html:inputs.map(f=>f.html)})});
        if(!response.ok)throw new Error(`Compile failed: ${response.status}`);
        css=await response.json();
      }
      if(disposed)return;
      if(variant!=="raster")for(const n of nodes){
        const host=document.createElement("div");host.dataset.prototypeFrame=n.id;
        host.style.cssText=`position:absolute;left:${n.x}px;top:${n.y}px;width:1200px;height:1000px;overflow:hidden;pointer-events:none;background:white;contain:layout style`;
        layer.appendChild(host);hosts.push(host);surfaces.push(await factory(variant,host));
      }
      probe.update=async(nextTheme,nextEdit=edit)=>{
        if(disposed)throw new Error("Disposed");
        theme=nextTheme;edit=nextEdit;
        const begun=performance.now(),reasons:string[]=[];let supported=0,innerNodes=0;
        if(variant==="raster"){
          for(let i=0;i<nodes.length;i++){
            const original=seedNodes[i%seedNodes.length]!,preview=original.thumbnails?.[original.theme??theme??""];
            if(preview&&preview.rev===original.rev&&edit===0){Object.assign(nodes[i]!,{thumbLo:preview.lo,thumbHi:preview.hi,thumbRev:nodes[i]!.rev});supported++;}
            else reasons.push("Raster requires a server render for this uncached content/theme pair");
          }
          paint();
          await timeout(new Promise<void>(resolve=>{const check=()=>{
            if(disposed)return resolve();
            const all=nodes.every(n=>{const url=thumbnailSource(n);return !!url&&!!cache.get(url)});
            if(all||supported===0){requestAnimationFrame(()=>resolve());return;}
            setTimeout(check,10);
          };check();}),20000);
        }else{
          let at=0;
          await timeout(Promise.all(Array.from({length:Math.min(8,nodes.length)},async()=>{
            for(let i=at++;i<nodes.length&&!disposed;i=at++){
              const input=inputs[i]!,html=edit?input.html.replace("Analytics",`Edited ${edit} Analytics`):input.html;
              const frame:PrototypeFrame={id:input.node.id,html,width:input.node.width,height:input.node.height,design:css.design??experimentalDesign,theme:effectiveTheme(input.node,theme),css:css.css,cssUrl:css.cssUrl,pixelWidth:input.node.width*z*devicePixelRatio};
              try{const ready=await surfaces[i]!.update(frame);innerNodes+=ready.domNodes??0;if(ready.supported)supported++;else reasons.push(ready.reason??"Unsupported");}
              catch(error){reasons.push(String(error));}
            }
          })),45000);
          await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
        }
        const sample:Sample={variant,count,theme,edit,elapsedMs:performance.now()-begun,navigationMs:performance.now(),supported,unsupported:count-supported,reasons:[...new Set(reasons)],domNodes:document.querySelectorAll("*").length+innerNodes,iframes:document.querySelectorAll("iframe").length,heapBytes:(performance as Performance&{memory?:{usedJSHeapSize:number}}).memory?.usedJSHeapSize??null,resourceBytes:performance.getEntriesByType("resource").reduce((sum,e)=>sum+(e as PerformanceResourceTiming).transferSize,0)};
        samples.push(sample);setStatus(JSON.stringify(sample));probe.ready=true;return sample;
      };
      await probe.update(theme,0);
      setStatus(s=>`Initial preparation ${Math.round(performance.now()-start)} ms · ${s}`);
    })().catch(error=>setStatus(String(error)));
    return()=>{disposed=true;for(const s of surfaces)s.dispose();for(const h of hosts)h.remove();cache.dispose();loader.dispose();if(window.__sharpnerPrototype===probe)delete window.__sharpnerPrototype;};
  },[loaded,sourceKey,design,variant,count,caseName,pageId]);
  const select=(next:string)=>{const url=new URL(location.href);url.searchParams.set("variant",next);location.href=url.href;};
  return <div ref={root} className="canvas" style={{overflow:"hidden"}} data-prototype={variant}>
    <canvas ref={raster} className="raster" style={{width:"100%",height:"100%",display:variant==="raster"?undefined:"none"}}/>
    <div ref={world} className="world" style={{transformOrigin:"0 0"}}/>
    <div style={{position:"absolute",left:16,right:16,bottom:12,padding:10,background:"#171717",border:"1px solid #777",borderRadius:8,color:"white",fontSize:11,zIndex:20}}>
      <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:6}}><button onClick={()=>select(variants[(variants.indexOf(variant)+4)%5]!)}>←</button><b>THROWAWAY · {variant} · {count} screens · {caseName}</b><button onClick={()=>select(variants[(variants.indexOf(variant)+1)%5]!)}>→</button>{["light","dark",null].map(t=><button key={t??"authored"} onClick={()=>void window.__sharpnerPrototype?.update(t)}>{t??"As authored"}</button>)}<button onClick={()=>void window.__sharpnerPrototype?.update("dark",Date.now())}>Source edit</button></div>
      <pre style={{margin:0,whiteSpace:"pre-wrap",maxHeight:90,overflow:"auto"}}>{status}</pre>
    </div>
  </div>;
}
