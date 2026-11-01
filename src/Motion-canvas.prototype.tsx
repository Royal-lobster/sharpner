// THROWAWAY: Compare reload, persistent, bounded pool and eager execution on the real editor route.
// No Room writes. Posters are schematic: this experiment measures runtime scheduling, not capture fidelity.
import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { Canvas } from "./Canvas";
import { frameDocument } from "../shared/types";
import { api } from "./api";
import { motionSource, motionDesign, motionPoster } from "./motion-fixture.prototype";
import { benchmarkMotion } from "./motion-benchmark.prototype";

type Strategy = "reload" | "persistent" | "pool" | "eager";
export type Options = { strategy: Strategy; count: number; cap: number; rows: number; mode: "simulation" | "scheduled" | "native" };
type Probe = Record<string, any>;
type Surface = { index: number; frame: HTMLIFrameElement; token: string; ready: Promise<Probe>; probe: Probe };
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const stats = (values: number[]) => { const s=values.toSorted((a,b)=>a-b);return {n:s.length,median:s[Math.floor(s.length*.5)]??0,p95:s[Math.min(s.length-1,Math.floor(s.length*.95))]??0,max:s.at(-1)??0}; };

function childBridge(token:string) {
  const runtime=()=> (window as unknown as {sharpnerMotion:{command:(c:Record<string,unknown>)=>unknown}}).sharpnerMotion;
  const post=(seq:number)=>parent.postMessage({kind:"motion:reply",token,seq,value:{...runtime().command({type:"inspect"}) as object,componentText:document.querySelector("[data-motion-component]")?.textContent,bodyColor:getComputedStyle(document.body).backgroundColor}},"*");
  addEventListener("message",e=>{
    if(e.source!==parent||e.data?.kind!=="motion:command"||e.data.token!==token)return;
    runtime().command(e.data.command);
    if(e.data.command.type==="inspect")post(e.data.seq);
    else requestAnimationFrame(()=>setTimeout(()=>post(e.data.seq),0));
  });
  addEventListener("load",()=>void document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>post(0)))),{once:true});
}

export class MotionExperiment {
  surfaces=new Map<number,Surface>(); cards:HTMLDivElement[]=[]; saved=new Map<number,unknown>();
  css="";source="";themeName:"dark"|"light"="dark";focused:number|null=null;serial=0;created=0;disposed=0;epoch=0;
  design=motionDesign;
  longTasks:number[]=[];events:Probe[]=[];ready:Promise<unknown>=Promise.resolve();
  pending=new Map<string,{resolve:(probe:Probe)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  observer:PerformanceObserver;
  focusTimer:ReturnType<typeof setTimeout>|undefined;themeTimer:ReturnType<typeof setTimeout>|undefined;
  pendingFocus:((v:unknown)=>void)|undefined;pendingTheme:((v:unknown)=>void)|undefined;
  transition:Promise<unknown>=Promise.resolve();
  onMessage=(e:MessageEvent)=>{
    const d=e.data;if(d?.kind!=="motion:reply")return;
    const surface=[...this.surfaces.values()].find(s=>s.token===d.token&&s.frame.contentWindow===e.source);if(!surface)return;
    surface.probe=d.value;const pending=this.pending.get(`${d.token}:${d.seq}`);
    if(pending){clearTimeout(pending.timer);this.pending.delete(`${d.token}:${d.seq}`);pending.resolve(d.value);}
  };
  onResize=()=>this.layout();onVisibility=()=>{if(document.hidden)void this.pauseAll();};
  constructor(public host:HTMLDivElement,public options:Options,public report:(p:Probe)=>void){
    addEventListener("message",this.onMessage);addEventListener("resize",this.onResize);document.addEventListener("visibilitychange",this.onVisibility);
    this.observer=new PerformanceObserver(list=>this.longTasks.push(...list.getEntries().map(e=>e.duration)));
    this.observer.observe({type:"longtask",buffered:false});
  }
  wait(surface:Surface,seq:number){return new Promise<Probe>((resolve,reject)=>{
    const key=`${surface.token}:${seq}`,timer=setTimeout(()=>{this.pending.delete(key);reject(new Error(`Surface ${surface.index} timed out (${seq})`));},15000);
    this.pending.set(key,{resolve,reject,timer});
  });}
  async command(index:number,command:Probe){
    const s=this.surfaces.get(index);if(!s)throw new Error(`Surface ${index} not resident`);await s.ready;
    const seq=++this.serial,result=this.wait(s,seq);s.frame.contentWindow!.postMessage({kind:"motion:command",token:s.token,seq,command},"*");return result;
  }
  async setup(options:Partial<Options>={}){
    const epoch=++this.epoch;this.clear();this.options={...this.options,...options};this.focused=null;
    this.source=motionSource({rows:this.options.rows});
    const compiled=await api<{css:string;ms:number}>("/motion-prototype/css",{method:"POST",json:{design:motionDesign,html:this.source}});
    if(epoch!==this.epoch)return;
    this.css=compiled.css;const start=performance.now();this.host.replaceChildren();this.cards=[];const poster=motionPoster(this.themeName);
    for(let index=0;index<this.options.count;index++){
      const card=document.createElement("div");card.className="motion-prototype-card";card.dataset.index=String(index);
      const img=document.createElement("img");img.src=poster;img.alt=`Cached scenario ${index+1}`;card.appendChild(img);this.host.appendChild(card);this.cards.push(card);
      card.ondblclick=()=>void this.focus(index);
    }
    this.layout();await paint();const posterMs=performance.now()-start;
    const admitted=this.options.strategy==="eager"?this.options.count:Math.min(this.options.cap,this.options.count);
    await Promise.all(Array.from({length:admitted},(_,i)=>this.mount(i)));await this.playAll();await paint();
    const result={kind:"setup",options:this.options,posterMs,inputReadyMs:performance.now()-start,compileMs:compiled.ms,residents:this.surfaces.size,created:this.created,cssBytes:this.css.length,sourceBytes:this.source.length};
    this.events.push(result);this.report(result);return result;
  }
  async mount(index:number){
    if(this.surfaces.has(index))return this.surfaces.get(index)!.ready;
    const token=crypto.randomUUID(),frame=document.createElement("iframe");frame.sandbox.add("allow-scripts","allow-forms");frame.title=`Market simulation ${index+1}`;frame.dataset.motionSurface=String(index);
    const surface:Surface={index,frame,token,ready:Promise.resolve({}),probe:{}};this.surfaces.set(index,surface);this.created++;surface.ready=this.wait(surface,0);
    const csp="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data:;font-src 'none';connect-src 'none';frame-src 'none';form-action 'none';base-uri 'none';object-src 'none'";
    const html=frameDocument(this.source,{design:this.design,theme:this.themeName,compiledTailwind:true,tailwindCss:this.css});
    frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>(${childBridge.toString()})(${JSON.stringify(token)})</script>`+html;
    this.cards[index]!.appendChild(frame);this.layout();await surface.ready;
    await this.command(index,{type:"mode",value:this.options.mode});
    if(this.saved.has(index))await this.command(index,{type:"restore",state:this.saved.get(index)});
    await this.command(index,{type:"theme",theme:this.themeName});return surface.probe;
  }
  async unmount(index:number){const s=this.surfaces.get(index);if(!s)return;const before=await this.command(index,{type:"inspect"}),p=await this.command(index,{type:"pause"});this.saved.set(index,{...p.state,playing:before.playing});s.frame.remove();this.surfaces.delete(index);this.disposed++;}
  async freshTheme(theme:"light"|"dark"){
    const start=performance.now();this.themeName=theme;
    for(const index of [...this.surfaces.keys()]){await this.unmount(index);await this.mount(index);}
    await paint();return {ms:performance.now()-start,probes:await this.all({type:"inspect"})};
  }
  async focus(index:number,full=true){
    const start=performance.now();
    if(this.options.strategy==="reload"){for(const i of [...this.surfaces.keys()])await this.unmount(i);this.saved.delete(index);}
    else if(!this.surfaces.has(index)){while(this.surfaces.size>=Math.max(1,this.options.cap))await this.unmount(this.surfaces.keys().next().value!);}
    await this.mount(index);this.focused=full?index:null;this.layout();
    if(full)await Promise.all([...this.surfaces.keys()].filter(i=>i!==index).map(i=>this.command(i,{type:"pause"})));
    await this.command(index,{type:"play"});await paint();return {ms:performance.now()-start,residents:this.surfaces.size,index,probe:await this.command(index,{type:"inspect"})};
  }
  requestFocus(index:number,full=true){
    clearTimeout(this.focusTimer);this.pendingFocus?.({superseded:true});
    return new Promise(resolve=>{this.pendingFocus=resolve;this.focusTimer=setTimeout(()=>{this.pendingFocus=undefined;this.transition=this.transition.then(()=>this.focus(index,full)).then(resolve);},80);});
  }
  requestTheme(theme:"light"|"dark"){
    clearTimeout(this.themeTimer);this.pendingTheme?.({superseded:true});
    return new Promise(resolve=>{this.pendingTheme=resolve;this.themeTimer=setTimeout(()=>{this.pendingTheme=undefined;this.transition=this.transition.then(()=>this.theme(theme)).then(resolve);},80);});
  }
  async overview(){this.focused=null;this.layout();await this.playAll();await paint();}
  layout(){
    const w=this.host.clientWidth,h=this.host.clientHeight,columns=Math.ceil(Math.sqrt(this.options.count*w/h*760/1000));
    const scale=Math.min((w-36)/(columns*1030),(h-40)/(Math.ceil(this.options.count/columns)*790));
    this.cards.forEach((card,i)=>{const selected=i===this.focused,z=selected?Math.min((w-40)/1000,(h-40)/760):scale;
      Object.assign(card.style,{left:`${selected?(w-1000*z)/2:18+(i%columns)*1030*scale}px`,top:`${selected?(h-760*z)/2:18+Math.floor(i/columns)*790*scale}px`,transform:`scale(${z})`,zIndex:selected?"3":"1",opacity:this.focused===null||selected?"1":".1"});});
    for(const [index,s] of this.surfaces){s.frame.style.pointerEvents=index===this.focused?"auto":"none";s.frame.tabIndex=index===this.focused?0:-1;}
  }
  async all(c:Probe){return Promise.all([...this.surfaces.keys()].map(i=>this.command(i,c)));}
  async playAll(){return this.all({type:"play"});}async pauseAll(){return this.all({type:"pause"});}
  async theme(theme:"light"|"dark"){
    const start=performance.now();this.themeName=theme;const poster=motionPoster(theme);
    for(const card of this.cards)(card.firstElementChild as HTMLImageElement).src=poster;
    if(this.options.strategy==="reload"){for(const i of [...this.surfaces.keys()]){await this.unmount(i);this.saved.delete(i);await this.mount(i);await this.command(i,{type:"play"});}}
    else await this.all({type:"theme",theme});await paint();
    return {ms:performance.now()-start,theme,residents:this.surfaces.size,probes:await this.all({type:"inspect"})};
  }
  async sample(ms=3000,pan=false){
    this.longTasks=[];const gaps:number[]=[],start=performance.now();let prior=start;
    const before=await this.all({type:"inspect"});
    await new Promise<void>(resolve=>{const tick=(now:number)=>{gaps.push(now-prior);prior=now;
      if(pan)this.host.style.transform=`translate(${Math.sin((now-start)/350)*18}px,${Math.cos((now-start)/400)*12}px)`;
      if(now-start<ms)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});this.host.style.transform="";
    const after=await this.all({type:"inspect"});return {elapsed:performance.now()-start,gaps:stats(gaps.slice(1)),longTasks:stats(this.longTasks),longTaskTotal:this.longTasks.reduce((a,b)=>a+b,0),before,after,residents:this.surfaces.size};
  }
  async inspect(){return {options:this.options,theme:this.themeName,focused:this.focused,residents:this.surfaces.size,created:this.created,disposed:this.disposed,saved:this.saved.size,probes:await this.all({type:"inspect"})};}
  benchmark(options:Partial<Options>,runs=3,duration=3000){return benchmarkMotion(this,options,runs,duration);}
  clear(){clearTimeout(this.focusTimer);clearTimeout(this.themeTimer);this.pendingFocus?.({superseded:true});this.pendingTheme?.({superseded:true});this.pendingFocus=undefined;this.pendingTheme=undefined;for(const s of this.surfaces.values())s.frame.remove();this.disposed+=this.surfaces.size;this.surfaces.clear();this.saved.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error("Experiment reset"));}this.pending.clear();}
  dispose(){this.epoch++;this.clear();this.observer.disconnect();removeEventListener("message",this.onMessage);removeEventListener("resize",this.onResize);document.removeEventListener("visibilitychange",this.onVisibility);}
}
declare global{interface Window{__motionPrototype?:MotionExperiment;}}
const variants:Strategy[]=["reload","persistent","pool","eager"];
export function MotionCanvasPrototype(_props:ComponentProps<typeof Canvas>){
  const host=useRef<HTMLDivElement>(null),experiment=useRef<MotionExperiment>(null),params=new URLSearchParams(location.search);
  const [variant,setVariant]=useState<Strategy>((params.get("variant") as Strategy)||"pool");
  const [count,setCount]=useState(Number(params.get("count"))||40),[cap,setCap]=useState(Number(params.get("cap")??4));
  const [mode,setMode]=useState<Options["mode"]>("scheduled"),[result,setResult]=useState<Probe>({status:"Preparing…"});
  const [theme,setTheme]=useState<"light"|"dark">("dark"),[playing,setPlaying]=useState(true),[focused,setFocused]=useState(false);
  useEffect(()=>{const runner=new MotionExperiment(host.current!,{strategy:variant,count,cap:variant==="reload"||variant==="persistent"?1:cap,rows:24,mode},setResult);experiment.current=runner;window.__motionPrototype=runner;
    runner.ready=runner.setup().catch(e=>setResult({error:String(e)}));return()=>{runner.dispose();delete window.__motionPrototype;};},[variant,count,cap,mode]);
  const run=async(fn:(r:MotionExperiment)=>Promise<unknown>)=>{try{const r=experiment.current!;await r.ready;setResult(await fn(r) as Probe);}catch(e){setResult({error:String(e)});}};
  return <div className="motion-prototype">
    <style>{`.motion-prototype{position:absolute;inset:0;background:var(--background);overflow:hidden}.motion-prototype-host{position:absolute;inset:50px 0 112px;will-change:transform}.motion-prototype-card{position:absolute;width:1000px;height:760px;transform-origin:0 0;outline:1px solid #8884;background:#10171c}.motion-prototype-card>img,.motion-prototype-card>iframe{position:absolute;inset:0;width:1000px;height:760px;border:0}.motion-prototype-info{position:absolute;top:8px;left:12px;right:12px;display:flex;gap:12px;align-items:center;font-size:11px;z-index:8}.motion-prototype-controls{position:absolute;bottom:12px;left:12px;right:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px;background:var(--card);border:1px solid var(--border);border-radius:12px;z-index:8;font-size:11px}.motion-prototype-controls button,.motion-prototype-controls select{border:1px solid var(--border);background:var(--background);color:var(--foreground);border-radius:6px;padding:6px 9px;cursor:pointer}.motion-prototype-controls button[data-on=true]{background:var(--primary);color:var(--primary-foreground)}.motion-prototype-readout{max-width:380px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:monospace}@media(max-width:600px){.motion-prototype-host{bottom:180px}.motion-prototype-info span{display:none}}`}</style>
    <div className="motion-prototype-info"><strong>INTERACTION-FIRST · THROWAWAY</strong><span>Same editor/auth · synthetic trading fixture · schematic posters · no writes</span></div>
    <div ref={host} className="motion-prototype-host"/>
    <div className="motion-prototype-controls" role="toolbar" aria-label="Motion experiment">
      {variants.map(key=><button key={key} data-on={variant===key} onClick={()=>{setVariant(key);const u=new URL(location.href);u.searchParams.set("variant",key);history.replaceState(null,"",u);}}>{key}</button>)}
      <select aria-label="Screen count" value={count} onChange={e=>setCount(Number(e.target.value))}>{[1,40,100,300].map(n=><option key={n}>{n}</option>)}</select>
      <select aria-label="Live budget" value={cap} onChange={e=>setCap(Number(e.target.value))}>{[0,1,4,12,40].map(n=><option key={n}>{n}</option>)}</select>
      <select aria-label="Motion mode" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="simulation">rAF + 10Hz data</option><option value="scheduled">10Hz scheduled data</option><option value="native">Native motion only</option></select>
      <button onClick={()=>void run(async r=>{const v=await r.theme(theme==="dark"?"light":"dark");setTheme(v.theme);return v;})}>Theme · {theme}</button>
      <button onClick={()=>void run(async r=>{if(focused){await r.overview();setFocused(false);return r.inspect();}setFocused(true);return r.focus(0);})}>{focused?"Overview":"Focus"}</button>
      <button onClick={()=>void run(async r=>{const v=await(playing?r.pauseAll():r.playAll());setPlaying(!playing);return {playing:!playing,value:v};})}>{playing?"Pause":"Play"}</button>
      <button onClick={()=>void run(r=>r.all({type:"reset"}))}>Reset</button>
      <button onClick={()=>void run(r=>r.all({type:"scenario",scenario:"deposit"}))}>Deposit</button>
      <button onClick={()=>void run(r=>r.all({type:"scenario",scenario:"trade"}))}>Trade</button>
      <button onClick={()=>void run(r=>r.all({type:"seek",time:1750}))}>Seek 1.75s</button>
      <button onClick={()=>void run(r=>r.sample(3000,true))}>Measure 3s</button>
      <span className="motion-prototype-readout" title={JSON.stringify(result)}>{JSON.stringify(result,(_k,v)=>Array.isArray(v)?`${v.length} items`:v).slice(0,300)}</span>
    </div>
  </div>;
}
