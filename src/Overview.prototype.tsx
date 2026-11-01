// THROWAWAY: instrument the existing Canvas/Room, with actual distinct server-generated previews.
import {useEffect,useState} from "react";
import {Room} from "./room";
import {api} from "./api";
import {overviewFixture} from "../shared/overview-fixture.prototype";
import {frameDocument,type DesignSystem,type Op} from "../shared/types";
import {overviewInstrumentation,type OverviewDraw} from "./overview-instrumentation.prototype";
import {overviewCaptureBridge,captureWarmOverviewFrame,type OverviewCaptureResult} from "./overview-capture.prototype";
import {createSharedOverview,type SharedOverviewProbe} from "./overview-shared.prototype";
import {createDocumentOverview} from "./overview-documents.prototype";
import {createAtlasOverview} from "./overview-atlas.prototype";
import {layoutRects,layoutHeight} from "../shared/layout";

type Prepared={css:string;cssUrl:string;ms:number;design:DesignSystem};
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const summary=(values:number[])=>{const s=values.toSorted((a,b)=>a-b);return {n:s.length,p50:s[Math.floor(s.length*.5)]??0,p95:s[Math.min(s.length-1,Math.floor(s.length*.95))]??0,p99:s[Math.min(s.length-1,Math.floor(s.length*.99))]??0,max:s.at(-1)??0};};
function warmReady(token:string){addEventListener("load",()=>{document.body.getBoundingClientRect();void document.fonts.ready.then(()=>{
  const landmarks:any[]=[];for(const selector of ["main.ov-shell","h1",".ov-card","input","table",".ov-chart"])[...document.querySelectorAll(selector)].slice(0,selector===".ov-card"?2:1).forEach((element,index)=>{const rect=element.getBoundingClientRect(),css=getComputedStyle(element);landmarks.push({selector,index,x:rect.x,y:rect.y,w:rect.width,h:rect.height,fontFamily:css.fontFamily,fontSize:css.fontSize,lineHeight:css.lineHeight});});
  const style=getComputedStyle(document.body);parent.postMessage({type:"overview-warm-ready",token,fonts:[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family),measuredHeight:Math.ceil(document.body.getBoundingClientRect().height),check:{bodyBackground:style.backgroundColor,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight},landmarks},"*");
});},{once:true});}

export class OverviewExperiment{
  fixture:ReturnType<typeof overviewFixture>;rows:OverviewDraw[]=[];size={w:0,h:0};lastDraw=0;
  measurement:any=null;result:any=null;trace:any[]=[];gaps:number[]=[];longTasks:number[]=[];
  thresholds:Record<string,number>={};lastFrame=0;lastSample=0;raf=0;peakLive=0;
  prepared:Prepared|null=null;captureResults:any[]=[];localDone:Promise<unknown>|null=null;captureAbort=new AbortController();
  pendingUploads:Promise<any>[]=[];uploadResults:any[]=[];samples:Record<string,string>={};
  finished:Promise<any>=Promise.resolve();resolveFinish:((v:unknown)=>void)|null=null;
  observer:PerformanceObserver;
  unsubscribe:()=>void;
  shared:ReturnType<typeof createSharedOverview>|null=null;sharedTheme="";sharedEvents:any[]=[];sharedChange:Promise<unknown>|null=null;sharedProbe:SharedOverviewProbe|null=null;
  documents:ReturnType<typeof createDocumentOverview>|null=null;documentTheme:string|null=null;documentEvents:any[]=[];documentChange:Promise<unknown>|null=null;documentProbe:any=null;corpusBase:string|null=null;
  atlas:Awaited<ReturnType<typeof createAtlasOverview>>|null=null;atlasResults:any[]=[];atlasRaw:any=null;
  constructor(public room:Room,public fileId:string,public workspaceId:string,public count:number,public report:(value:any)=>void){
    this.fixture=overviewFixture(count,fileId,{columns:count>100?18:8});
    overviewInstrumentation.draw=(rows,size)=>{this.rows=rows;this.size=size;this.lastDraw=performance.now();};
    this.observer=new PerformanceObserver(list=>{if(this.measurement?.started)this.longTasks.push(...list.getEntries().map(e=>e.duration));});
    this.observer.observe({type:"longtask"});
    this.unsubscribe=room.subscribe(()=>{if(this.measurement&&this.measurement.started===null&&room.fileTheme===this.measurement.theme)this.measurement.started=performance.now();if(this.shared&&room.fileTheme&&this.sharedTheme!==room.fileTheme){this.sharedTheme=room.fileTheme;this.sharedChange=this.sharedRetheme(room.fileTheme);}if(this.documents&&this.documentTheme!==room.fileTheme){this.documentTheme=room.fileTheme;this.documentChange=this.documentsRetheme(room.fileTheme);}});
  }
  call<T=any>(action:string,json:unknown={}){return api<T>(`/files/${this.fileId}/overview-prototype/${action}`,{method:"POST",json});}
  async create(count:number,mode="full"){
    const file=await api<{id:string}>(`/workspaces/${this.workspaceId}/files`,{method:"POST",json:{name:`PROTOTYPE · overview ${count} ${mode} ${Date.now()}`}});
    return {...file,url:`/f/${file.id}?prototype=overview&count=${count}&mode=${mode}`};
  }
  async seed(){
    if(this.room.nodes.size)throw new Error("Seed requires an empty synthetic file");
    await this.call("config",{hold:true,mode:new URLSearchParams(location.search).get("mode")??"full",resetMetrics:true});
    const page=this.room.pages[0]!.id,ds=`${this.fileId}-design`;
    const ops:Op[]=[{t:"page.put",page:{id:ds,name:"Design system",sort:1}},{t:"theme.set",theme:"light"},
      {t:"node.put",id:`${this.fileId}-tokens`,node:{pageId:ds,kind:"tokens",name:"Overview foundations",source:this.fixture.tokens,x:0,y:0,width:960,height:null}},
      ...this.fixture.components.map((c,i):Op=>({t:"node.put",id:`${this.fileId}-component-${i}`,node:{pageId:ds,kind:"component",name:c.tag.replace(/^x-/,"").split("-").join("/"),theme:c.theme??null,source:c.html,x:1200+i*450,y:0,width:400,height:null}})),
      ...this.fixture.nodes.map((n):Op=>({t:"node.put",id:n.id,node:{pageId:page,kind:"frame",name:n.name,source:n.source,x:n.x,y:n.y,width:n.width,height:n.height,order:n.order}})),
      {t:"cover.set",id:this.fixture.nodes[0]!.id}];
    // DS+sources are written in one real transaction, never to an existing user's file.
    await this.call("seed",{ops});await sleep(100);overviewInstrumentation.canvas?.fit();
    this.report({seeded:this.fixture.metadata,count:this.count});return this.fixture.metadata;
  }
  fit(){overviewInstrumentation.canvas?.fit();}
  async baseline(mode="full"){
    if(this.documents)this.documentsStop();
    if(this.shared)this.sharedStop();
    await this.call("config",{hold:false,mode,resetMetrics:true});this.arm("light",`baseline-${mode}`,120000);return {armed:true};
  }
  arm(theme:string,label=theme,timeout=120000){
    this.stop();this.result=null;this.trace=[];this.gaps=[];this.longTasks=[];this.thresholds={};this.peakLive=0;this.lastFrame=0;this.lastSample=0;
    this.measurement={theme,label,armed:performance.now(),started:this.room.fileTheme===theme?performance.now():null,timeout};
    this.finished=new Promise(resolve=>this.resolveFinish=resolve);
    const tick=(now:number)=>{
      const m=this.measurement;if(!m)return;
      if(!m.started&&this.room.fileTheme===m.theme)m.started=now;
      if(m.started){
        if(this.lastFrame)this.gaps.push(now-this.lastFrame);this.lastFrame=now;
        const visible=this.rows.filter(r=>r.kind==="frame");let area=0,correctArea=0,painted=0,correct=0;
        for(const r of visible){const a=Math.max(0,Math.min(this.size.w,r.x+r.w)-Math.max(0,r.x))*Math.max(0,Math.min(this.size.h,r.y+r.h)-Math.max(0,r.y));area+=a;if(r.painted)painted++;if(r.current&&r.theme===m.theme){correctArea+=a;correct++;}}
        const coverage=area?correctArea/area:0,elapsed=Math.max(0,now-m.started);
        const ready=this.fixture.nodes.filter(n=>{const node=this.room.nodes.get(n.id),t=node?.thumbnails?.[m.theme];return t&&t.rev===node.rev;}).length;
        if(coverage>=.5&&this.thresholds.half===undefined)this.thresholds.half=elapsed;
        if(coverage>=.95&&this.thresholds.p95===undefined)this.thresholds.p95=elapsed;
        if(coverage>=.99999&&correct===this.count&&this.thresholds.all===undefined)this.thresholds.all=elapsed;
        this.peakLive=Math.max(this.peakLive,overviewInstrumentation.canvas?.live??0);
        if(now-this.lastSample>=100){this.trace.push({ms:elapsed,coverage,ready,correct,painted,visible:visible.length,live:overviewInstrumentation.canvas?.live??0});this.lastSample=now;this.report(this.trace.at(-1));}
        if((coverage>=.99999&&correct===this.count&&ready===this.count)||elapsed>m.timeout){
          this.result={theme:m.theme,label:m.label,count:this.count,elapsed,coverage,ready,correct,visible:visible.length,times:this.thresholds,gaps:summary(this.gaps),longTasks:summary(this.longTasks),longTaskMs:this.longTasks.reduce((a,b)=>a+b,0),peakLive:this.peakLive,trace:this.trace,timedOut:elapsed>m.timeout};
          this.measurement=null;this.resolveFinish?.(this.result);this.report(this.result);return;
        }
      }
      this.raf=requestAnimationFrame(tick);
    };this.raf=requestAnimationFrame(tick);return {armed:theme,label};
  }
  stop(){cancelAnimationFrame(this.raf);this.measurement=null;}
  async server(theme:string,mode="full"){
    if(this.documents)this.documentsStop();
    if(this.shared)this.sharedStop();
    await this.call("config",{mode,hold:false,resetMetrics:true});this.arm(theme,`${mode}-${theme}`);this.room.send([{t:"theme.set",theme}]);return {armed:true};
  }
  async prepareLocal(){
    await this.call("config",{hold:true,resetMetrics:true});const start=performance.now();
    this.prepared=await this.call<Prepared>("prepare",{design:{tokens:this.fixture.tokens,components:this.fixture.components},html:this.fixture.nodes.map(n=>n.source)});
    return {requestMs:performance.now()-start,workerMs:this.prepared.ms,cssBytes:this.prepared.css.length};
  }
  async importCorpus(data:{name:string;theme:string|null;design:DesignSystem;nodes:any[];base?:string},limit=300){
    this.atlasStop();
    // Private sources stay in this local PROTOTYPE room and the browser, never in repository fixtures.
    this.documentsStop();this.sharedStop();await this.call("config",{hold:true,resetMetrics:true});
    const selected=data.nodes.slice(0,Math.min(300,limit)),columns=selected.length>100?18:8;
    const nodes=selected.map((n,i)=>({id:`${this.fileId}-corpus-${i}`,family:this.fixture.nodes[0]!.family,structural:false,name:n.name,source:n.source,width:n.width,height:n.heightMode==="auto"?null:n.height,x:i%columns*1500,y:Math.floor(i/columns)*2200,order:i,measuredHeight:n.renderedHeight??n.height}));
    const page=this.room.pages[0]!.id,ds=this.room.pages.find(p=>p.name==="Design system")?.id??`${this.fileId}-design`;
    await this.call("seed",{ops:[{t:"node.del",ids:[...this.room.nodes.keys()]},{t:"page.put",page:{id:ds,name:"Design system",sort:1}},{t:"theme.set",theme:data.theme}]});
    const ops:Op[]=[{t:"node.put",id:`${this.fileId}-tokens`,node:{pageId:ds,kind:"tokens",name:"Corpus foundations",source:data.design.tokens,x:0,y:0,width:960,height:null}},
      ...data.design.components.map((c,i):Op=>({t:"node.put",id:`${this.fileId}-component-${i}`,node:{pageId:ds,kind:"component",name:c.tag.replace(/^x-/,"").split("-").join("/"),theme:c.theme??null,source:c.html,x:1200+i*450,y:0,width:400,height:null}})),
      ...nodes.map((n):Op=>({t:"node.put",id:n.id,node:{pageId:page,kind:"frame",name:n.name,source:n.source,width:n.width,height:n.height,x:n.x,y:n.y,order:n.order}}))];
    for(let i=0;i<ops.length;i+=10)await this.call("seed",{ops:ops.slice(i,i+10)});
    this.corpusBase=data.base??"https://sharpner.app/";this.count=nodes.length;this.fixture={...this.fixture,nodes,tokens:data.design.tokens,components:data.design.components};this.prepared=null;
    this.room.overviewHeights(nodes.map(n=>({id:n.id,measuredHeight:n.measuredHeight})));this.fit();return {name:data.name,frames:nodes.length,components:data.design.components.length,sourceBytes:nodes.reduce((s,n)=>s+n.source.length,0)};
  }
  async documentsStart(options:{otherOrigin?:boolean;componentRefresh?:boolean;residentLimit?:number;concurrency?:number;themeConcurrency?:number}={}){
    this.atlasStop();
    this.documentsStop();if(this.shared)this.sharedStop();await this.call("config",{hold:true,resetMetrics:true});
    const started=performance.now(),reusedPreparation=!!this.prepared;
    // Ordinary source styles remain in each document. Only file-wide Tailwind/token CSS is shared.
    const classes=[...new Set([...this.fixture.nodes.map(n=>n.source),...this.fixture.components.map(c=>c.html)].flatMap(html=>[...html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap(m=>(m[1]??m[2]??m[3]!).split(/\s+/))))];
    this.prepared??=await this.call<Prepared>("prepare",{design:{tokens:this.fixture.tokens,components:this.fixture.components},html:[`<div class="${classes.join(" ").replace(/"/g,"&quot;")}"></div>`]});
    const preparationMs=performance.now()-started;this.documentTheme=this.room.fileTheme;this.documentEvents=[];
    const bootstrap=new URL("/api/overview-bootstrap",location.origin);if(options.otherOrigin)bootstrap.port="5201";
    const start=performance.now();this.documents=createDocumentOverview({nodes:this.fixture.nodes.map(n=>({...n,theme:this.room.nodes.get(n.id)?.theme,measuredHeight:this.room.nodes.get(n.id)?.measuredHeight??undefined})),design:this.prepared.design,cssUrl:new URL(this.prepared.cssUrl,location.origin).href,base:this.corpusBase??location.origin,theme:this.documentTheme,residentLimit:options.residentLimit??40,concurrency:options.concurrency??4,bootstrapUrl:options.otherOrigin?bootstrap.href:undefined,componentRefresh:options.componentRefresh,themeConcurrency:options.themeConcurrency});
    document.querySelector(".stage")!.appendChild(this.documents.element);const canvas=overviewInstrumentation.canvas!;this.documents.camera(canvas.cam,canvas.size);
    overviewInstrumentation.cameraObserver=(cam,size)=>this.documents?.camera(cam,size);
    const probe=await this.documents.ready;this.documentProbe=probe;this.documentEvents.push({initial:true,reusedPreparation,preparationMs,ms:performance.now()-start,probe});this.report({documents:true,reusedPreparation,preparationMs,ms:performance.now()-start,probe});return {...this.documentEvents.at(-1),probe:{...probe,nodes:undefined}};
  }
  async documentsRetheme(theme:string|null){const start=performance.now(),probe=await this.documents!.setTheme(theme);this.documentProbe=probe;const event={theme,ms:performance.now()-start,probe};this.documentEvents.push(event);this.report(event);return event;}
  documentsStop(){this.documents?.dispose();this.documents=null;overviewInstrumentation.cameraObserver=undefined;overviewInstrumentation.sharedActive=false;}
  async atlasRender(theme:string,side=128,cssTransport:"intercept"|"blob"="intercept"){
    const start=performance.now();if(this.shared)this.sharedStop();
    const pageId=new URLSearchParams(location.search).get("page")??this.room.pages[0]?.id;
    const pageNodes=[...this.room.nodes.values()].filter(n=>n.pageId===pageId),nodes=pageNodes.filter(n=>n.kind==="frame");this.count=nodes.length;
    // Keep the prior document pixels until the atlas is decoded. Do not retheme them during this server benchmark.
    if(this.documents){this.documentTheme=theme;this.documents.element.style.opacity=".55";}
    if(this.atlas)this.atlas.element.style.opacity=".55";
    this.room.send([{t:"theme.set",theme}]);
    const result=await this.call("atlas",{ids:nodes.map(n=>n.id),theme,side,base:this.corpusBase??location.origin,cssTransport});this.atlasRaw=result;
    this.room.overviewHeights(result.rects.filter((r:any)=>this.room.nodes.get(r.id)?.height===null).map((r:any)=>({id:r.id,measuredHeight:r.sourceHeight})));
    const positions=layoutRects(pageNodes,n=>n.height??this.room.heights.get(n.id)??layoutHeight(n));
    const beforeDecode=performance.now(),layer=await createAtlasOverview(result,nodes.map(n=>({...n,x:positions.get(n.id)!.x,y:positions.get(n.id)!.y})));
    if(this.room.fileTheme!==theme){layer.dispose();return {superseded:true};}
    this.documentsStop();const old=this.atlas;this.atlas=layer;document.querySelector(".stage")!.appendChild(layer.element);const canvas=overviewInstrumentation.canvas!;layer.camera(canvas.cam,canvas.size);old?.dispose();
    overviewInstrumentation.cameraObserver=(cam,size)=>this.atlas?.camera(cam,size);overviewInstrumentation.sharedActive=false;
    await new Promise<void>(r=>requestAnimationFrame(()=>r()));
    const summary={theme,elapsed:performance.now()-start,decodeDrawMs:performance.now()-beforeDecode,...result,imageBase64:undefined,nodes:result.rects.length,decodedPixels:layer.decodedPixels};this.atlasResults.push(summary);this.report(summary);return summary;
  }
  atlasStop(){this.atlas?.dispose();this.atlas=null;overviewInstrumentation.sharedActive=false;overviewInstrumentation.cameraObserver=undefined;}
  async documentsStress(ms=10000,interval=800,themes=["light","dusk","editorial"]){
    const canvas=overviewInstrumentation.canvas!,base={...canvas.cam},start=performance.now(),gaps:number[]=[],lag:number[]=[],longTasks:number[]=[],issued:any[]=[];let last=start,nextTheme=start+250,index=0,nextTimer=start+50;
    const observer=new PerformanceObserver(entries=>longTasks.push(...entries.getEntries().map(e=>e.duration)));observer.observe({type:"longtask"});
    let timer:ReturnType<typeof setTimeout>;const ping=()=>{lag.push(Math.max(0,performance.now()-nextTimer));nextTimer=performance.now()+50;timer=setTimeout(ping,50);};timer=setTimeout(ping,50);
    const offset=this.documentEvents.length;
    await new Promise<void>(resolve=>{const tick=(now:number)=>{gaps.push(now-last);last=now;const ratio=1.15,z=base.z*ratio;overviewInstrumentation.canvas?.setCam({z,x:canvas.size.w/2+(base.x-canvas.size.w/2)*ratio+Math.sin((now-start)/600)*20,y:canvas.size.h/2+(base.y-canvas.size.h/2)*ratio+Math.cos((now-start)/800)*15});
      if(now>=nextTheme){const theme=themes[index++%themes.length]!;issued.push({theme,ms:now-start});this.room.send([{t:"theme.set",theme}]);nextTheme=now+interval;}
      if(now-start<ms)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
    clearTimeout(timer!);observer.disconnect();this.fit();await this.documentChange;
    return {ms:performance.now()-start,count:this.count,gaps:summary(gaps.slice(1)),timerLag:summary(lag),longTasks:summary(longTasks),longTaskMs:longTasks.reduce((a,b)=>a+b,0),issued,events:this.documentEvents.slice(offset).map(e=>({...e,probe:{...e.probe,nodes:undefined}})),final:{...this.documentProbe,nodes:undefined}};
  }
  async warm(node:typeof this.fixture.nodes[number],theme:string){
    const token=crypto.randomUUID(),frame=document.createElement("iframe");frame.sandbox.add("allow-scripts");frame.width=String(node.width);frame.height=String(node.height??1000);frame.title=`Checkpoint ${node.id}`;
    frame.style.cssText=`position:fixed;left:-10000px;top:0;width:${node.width}px;height:${node.height??1000}px;border:0;pointer-events:none`;
    const ready=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{removeEventListener("message",receive);reject(new Error("Warm frame load deadline"));},8000);
      const receive=(e:MessageEvent)=>{if(e.source===frame.contentWindow&&e.data?.type==="overview-warm-ready"&&e.data.token===token){clearTimeout(timer);removeEventListener("message",receive);resolve(e.data);}};addEventListener("message",receive);});
    const html=frameDocument(node.source,{base:location.origin+"/",design:this.prepared!.design,theme,compiledTailwind:true});
    const cssUrl=new URL(this.prepared!.cssUrl,location.origin).href;
    frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline' ${location.origin};img-src data:;font-src data:;connect-src 'none';frame-src 'none';object-src 'none';form-action 'none'"><script>(${overviewCaptureBridge.toString()})(${JSON.stringify(token)});(${warmReady.toString()})(${JSON.stringify(token)})</script>`+html.replace("</head>",`<link rel="stylesheet" href="${cssUrl}"></head>`);
    document.body.appendChild(frame);const probe=await ready;return {frame,token,cssUrl,probe};
  }
  async reference(node:typeof this.fixture.nodes[number],theme:string|null){
    const token=crypto.randomUUID(),frame=document.createElement("iframe");frame.sandbox.add("allow-scripts");
    const height=node.height??this.room.nodes.get(node.id)?.measuredHeight??1000;frame.style.cssText=`position:fixed;left:-10000px;top:0;width:${node.width}px;height:${height}px;border:0;pointer-events:none`;
    const ready=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{removeEventListener("message",receive);reject(Error("Reference deadline"))},10000);const receive=(e:MessageEvent)=>{if(e.source===frame.contentWindow&&e.data?.type==="overview-reference"&&e.data.token===token){clearTimeout(timer);removeEventListener("message",receive);resolve(e.data.sample)}};addEventListener("message",receive)});
    function probe(token:string){addEventListener("load",()=>{void(async()=>{await new Promise(r=>setTimeout(r,120));document.body.getBoundingClientRect();await document.fonts.ready;await new Promise(r=>setTimeout(r,0));const landmarks:any[]=[];for(const selector of ["main","h1","button","input",".ov-card","table",".ov-chart"]){const element=document.querySelector(selector);if(!element)continue;const rect=element.getBoundingClientRect(),style=getComputedStyle(element);landmarks.push({selector,x:rect.x,y:rect.y,w:rect.width,h:rect.height,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight});}const body=getComputedStyle(document.body),root=getComputedStyle(document.documentElement);parent.postMessage({type:"overview-reference",token,sample:{height:Math.ceil(document.body.getBoundingClientRect().height),check:{bodyBackground:body.backgroundColor,rootBackground:root.backgroundColor,rootFontFamily:root.fontFamily,rootFontSize:root.fontSize,fontFamily:body.fontFamily,fontSize:body.fontSize,lineHeight:body.lineHeight},landmarks}},"*")})()},{once:true})}
    frame.srcdoc=frameDocument(node.source,{base:this.corpusBase??location.origin+"/",design:{tokens:this.fixture.tokens,components:this.fixture.components},theme}).replace("</head>",`<script>(${probe.toString()})(${JSON.stringify(token)})<\/script></head>`);document.body.appendChild(frame);try{return await ready}finally{frame.remove()}
  }
  async local(theme:string,cap=2){
    if(this.documents)this.documentsStop();
    if(this.shared)this.sharedStop();
    if(!this.prepared)await this.prepareLocal();
    await this.call("config",{hold:true,resetMetrics:true});this.arm(theme,`local-${cap}-${theme}`);this.room.send([{t:"theme.set",theme}]);
    this.captureAbort.abort();this.captureAbort=new AbortController();this.captureResults=[];this.uploadResults=[];this.pendingUploads=[];this.samples={};
    const queue=this.fixture.nodes.slice(),outbox:any[]=[];let live=0,peak=0;
    const flush=()=>{if(!outbox.length)return;const items=outbox.splice(0,8);this.pendingUploads.push(this.call("checkpoint",{items}).then(v=>this.uploadResults.push(v)));};
    this.localDone=Promise.all(Array.from({length:Math.min(4,cap)},async()=>{
      for(let node=queue.shift();node&&!this.captureAbort.signal.aborted;node=queue.shift()){
        // The explicit cover retains a full server capture.
        if(node.id===this.room.coverNodeId){this.captureResults.push({id:node.id,ok:false,unsupported:["cover-server-fallback"]});continue;}
        let warm:Awaited<ReturnType<OverviewExperiment["warm"]>>|undefined;const start=performance.now();
        try{
          live++;peak=Math.max(peak,live);warm=await this.warm(node,theme);
          const warmMs=performance.now()-start,result:OverviewCaptureResult=await captureWarmOverviewFrame(warm.frame,warm.token,{width:node.width,height:node.height,targetWidth:256,canonicalTimeMs:0,styles:this.prepared!.css,styleUrls:[warm.cssUrl],deadlineMs:1800},this.captureAbort.signal);
          this.captureResults.push({id:node.id,warmMs,...result,dataUrl:undefined});
          if(result.ok&&result.dataUrl){
            const canonical=this.room.nodes.get(node.id)!;
            this.room.overviewLocalPreview(node.id,theme,canonical.rev,result.dataUrl,result.measuredHeight);
            if(Object.keys(this.samples).length<3)this.samples[node.id]=result.dataUrl;
            outbox.push({id:node.id,rev:canonical.rev,theme,dataUrl:result.dataUrl,height:result.measuredHeight});if(outbox.length>=8)flush();
          }
        }catch(error){this.captureResults.push({id:node.id,ok:false,error:String(error)});}finally{warm?.frame.remove();live--;}
        await sleep(0);
      }
    })).then(async()=>{while(outbox.length)flush();await Promise.all(this.pendingUploads);await this.call("config",{hold:false,mode:"overview"});return {peak,results:this.captureResults,uploads:this.uploadResults};});
    return {started:true,cap};
  }
  async resultWithCost(){const cost=await this.call("config",{}),queue=await this.call("queue",{});return {result:this.result,cost,queue,local:this.captureResults,uploads:this.uploadResults};}
  async sharedStart(){
    this.documentsStop();
    await this.call("config",{hold:true,resetMetrics:true});if(!this.prepared)await this.prepareLocal();
    this.shared?.dispose();this.sharedTheme=this.room.fileTheme??"light";this.sharedEvents=[];
    const start=performance.now();this.shared=createSharedOverview({nodes:this.fixture.nodes.map(n=>({...n,theme:this.room.nodes.get(n.id)?.theme})),design:this.prepared!.design,cssUrl:this.prepared!.cssUrl,theme:this.sharedTheme,base:location.origin});
    this.shared.frame.style.opacity="0";document.querySelector(".stage")!.appendChild(this.shared.frame);
    const camera=overviewInstrumentation.canvas!;this.shared.camera(camera.cam,camera.size);
    const probe=await this.shared.ready;this.sharedProbe=probe;this.room.overviewHeights(probe.nodes);this.shared.frame.style.opacity="1";
    overviewInstrumentation.sharedActive=probe.rendered===this.count;overviewInstrumentation.cameraObserver=(cam,size)=>this.shared?.camera(cam,size);
    const event={initial:true,ms:performance.now()-start,probe};this.sharedEvents.push(event);this.report({initial:event.ms,rendered:probe.rendered,unsupported:probe.unsupported.length,nodes:probe.descendantNodes});return {ms:event.ms,rendered:probe.rendered,unsupported:probe.unsupported.slice(0,2),nodes:probe.descendantNodes};
  }
  async sharedRetheme(theme:string){
    const start=performance.now(),probe=await this.shared!.setTheme(theme);if(probe.superseded)return {superseded:true};
    this.sharedProbe=probe;this.room.overviewHeights(probe.nodes);const event={theme,ms:performance.now()-start,probe};this.sharedEvents.push(event);this.report({theme,ms:event.ms,rendered:probe.rendered,rebuilt:probe.rebuilt});return {theme,ms:event.ms,rendered:probe.rendered,rebuilt:probe.rebuilt};
  }
  sharedStop(){this.shared?.dispose();this.shared=null;overviewInstrumentation.sharedActive=false;overviewInstrumentation.cameraObserver=undefined;this.room.overviewHeights(this.fixture.nodes.map(n=>({id:n.id,measuredHeight:this.room.nodes.get(n.id)?.measuredHeight??n.height??800})));this.fit();}
  async sharedUnsupported(){
    const cases=[{name:"full-document",source:'<!doctype html><html><body>Full document</body></html>'},{name:"script",source:'<script>window.test=1</script>'},{name:"canvas",source:'<canvas></canvas>'},{name:"viewport",source:'<div style="width:100vw">Viewport</div>'},{name:"automatic-event",source:'<img src="data:image/png;base64," onerror="alert(1)">'},{name:"root-font",source:'<p>Root font</p>',tokens:this.prepared!.design.tokens+'\nhtml{font-size:20px}'},{name:"duplicate-id",source:'<p id="collision">One</p>',duplicate:true}];
    const results=[];for(const c of cases){const nodes=[{...this.fixture.nodes[0]!,source:c.source}];if(c.duplicate)nodes.push({...nodes[0]!,id:'duplicate',x:1500});const view=createSharedOverview({nodes,design:{...this.prepared!.design,tokens:c.tokens??this.prepared!.design.tokens},cssUrl:this.prepared!.cssUrl,theme:'light',base:location.origin});view.frame.style.opacity='0';document.body.appendChild(view.frame);try{const probe=await view.ready;results.push({name:c.name,rendered:probe.rendered,unsupported:probe.unsupported});}finally{view.dispose();}}return results;
  }
  async panProbe(ms=30000){
    const canvas=overviewInstrumentation.canvas!;const base={...canvas.cam},gaps:number[]=[];let last=performance.now();const start=last;
    await new Promise<void>(resolve=>{const tick=(now:number)=>{gaps.push(now-last);last=now;
      const z=base.z*1.15,ratio=z/base.z,centerX=canvas.size.w/2,centerY=canvas.size.h/2;
      overviewInstrumentation.canvas?.setCam({z,x:centerX+(base.x-centerX)*ratio+Math.sin((now-start)/600)*20,y:centerY+(base.y-centerY)*ratio+Math.cos((now-start)/800)*15});
      if(now-start<ms)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
    overviewInstrumentation.canvas?.fit();return {ms:performance.now()-start,gaps:summary(gaps.slice(1)),frames:gaps.length,count:this.count};
  }
  burstRooms:Room[]=[];
  async burst(files=10,screens=8){
    const entries:any[]=[];
    for(let i=0;i<files;i++){
      const file=await this.create(screens,"burst"),other=new Room(file.id);this.burstRooms.push(other);
      await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{off();reject(new Error("Burst Room startup timeout"));},15000);const off=other.subscribe(()=>{if(other.status==="open"){clearTimeout(timeout);off();resolve();}});});
      const page=other.pages[0]!.id,ds=file.id+"-design",fixture=overviewFixture(screens,file.id,{columns:4});
      const call=(action:string,json:unknown)=>api<any>(`/files/${file.id}/overview-prototype/${action}`,{method:"POST",json});
      other.setPresence({pageId:page});await call("config",{hold:true,mode:"overview",resetMetrics:true});
      const ops:Op[]=[{t:"page.put",page:{id:ds,name:"Design system",sort:1}},{t:"theme.set",theme:"light"},
        {t:"node.put",id:file.id+"-tokens",node:{pageId:ds,kind:"tokens",name:"Foundations",source:fixture.tokens,x:0,y:0,width:960,height:null}},
        ...fixture.components.map((c,j):Op=>({t:"node.put",id:file.id+"-component-"+j,node:{pageId:ds,kind:"component",name:c.tag.replace(/^x-/,"").split("-").join("/"),theme:c.theme??null,source:c.html,x:j*450,y:1000,width:400,height:null}})),
        ...fixture.nodes.map((n):Op=>({t:"node.put",id:n.id,node:{pageId:page,kind:"frame",name:n.name,source:n.source,x:n.x,y:n.y,width:n.width,height:n.height,order:n.order}}))];
      await call("seed",{ops});entries.push({fileId:file.id,other,fixture,call,events:[]});
    }
    const start=performance.now();
    const done=entries.map(e=>new Promise<void>(resolve=>{const off=e.other.subscribe(()=>{
      const ready=e.fixture.nodes.filter((n:any)=>{const node=e.other.nodes.get(n.id);return node?.thumbnails?.light?.rev===node?.rev;}).length;
      if(ready)e.events.push({ms:performance.now()-start,ready});
      if(ready===screens){off();e.finished=performance.now()-start;e.other.close();resolve();}
    });}));
    await Promise.all(entries.map(async e=>{e.submitted=performance.now()-start;await e.call("config",{hold:false});}));
    await Promise.race([Promise.all(done),sleep(45000)]);
    const results=[];for(const e of entries){e.other.close();results.push({fileId:e.fileId,submitted:e.submitted,first:e.events[0]?.ms,finished:e.finished??null,ready:e.events.at(-1)?.ready??0,cost:await e.call("config",{})});}
    this.burstRooms=[];return {files,screens,elapsed:performance.now()-start,results};
  }
  dispose(){this.stop();this.atlasStop();this.documentsStop();this.captureAbort.abort();this.observer.disconnect();this.unsubscribe();this.shared?.dispose();overviewInstrumentation.sharedActive=false;overviewInstrumentation.cameraObserver=undefined;for(const r of this.burstRooms)r.close();overviewInstrumentation.draw=undefined;}
}
declare global{interface Window{__overview?:OverviewExperiment;}}
export function OverviewPrototype({room,fileId,workspaceId}:{room:Room;fileId:string;workspaceId:string}){
  const [status,setStatus]=useState<any>({status:"Ready"});
  useEffect(()=>{const count=Number(new URLSearchParams(location.search).get("count"))||40;const p=new OverviewExperiment(room,fileId,workspaceId,count,setStatus);window.__overview=p;return()=>{p.dispose();delete window.__overview;};},[room,fileId,workspaceId]);
  const run=async(fn:(p:OverviewExperiment)=>Promise<any>|unknown)=>{try{setStatus(await fn(window.__overview!));}catch(e){setStatus({error:String(e)});}};
  return <div style={{position:"absolute",left:12,right:12,bottom:76,zIndex:30,display:"flex",gap:6,padding:8,borderRadius:10,background:"var(--card)",border:"1px solid var(--border)",fontSize:10,flexWrap:"wrap",alignItems:"center"}}>
    <strong>OVERVIEW EXPERIMENT</strong>
    {[40,300].map(count=><button key={count} onClick={()=>void run(async p=>{const f=await p.create(count,count>100?"overview128":"full");location.assign(f.url);return f;})}>New {count}</button>)}
    <button onClick={()=>void run(p=>p.seed())}>Seed fixture</button><button onClick={()=>void run(p=>p.baseline())}>Baseline full</button><button onClick={()=>void run(p=>p.baseline(p.count>100?"overview128":"overview"))}>Baseline small</button>
    <button onClick={()=>void run(p=>p.arm("dusk","real-controls-dusk"))}>Arm Dusk</button><button onClick={()=>void run(p=>p.arm("editorial","real-controls-editorial"))}>Arm Editorial</button>
    <button onClick={()=>void run(p=>p.server("dusk","overview"))}>Small Dusk</button><button onClick={()=>void run(p=>p.local("editorial",2))}>Local Editorial</button>
    <button onClick={()=>void run(p=>p.call("config",{hold:true}))}>Hold queue</button>
    <button onClick={()=>void run(p=>p.sharedStart())}>Shared HTML</button><button onClick={()=>void run(p=>p.shared?.policy(8,true))}>Batch 8</button><button onClick={()=>void run(p=>p.shared?.policy(0,false))}>Unbatched</button><button onClick={()=>void run(p=>p.sharedStop())}>Posters</button>
    <label>Import private corpus <input type="file" accept="application/json" style={{width:140}} onChange={event=>{const file=event.target.files?.[0];if(file)void run(async p=>p.importCorpus(JSON.parse(await file.text())));}}/></label>
    <button onClick={()=>void run(p=>p.documentsStart())}>Documents 40</button><button onClick={()=>void run(p=>p.documentsStart({otherOrigin:true,componentRefresh:true}))}>Isolated origin 40</button><button onClick={()=>void run(p=>p.documentsStop())}>Stop documents</button>
    <button onClick={()=>void run(p=>p.atlasRender("light"))}>Atlas Light</button><button onClick={()=>void run(p=>p.atlasRender("dark"))}>Atlas Dark</button><button onClick={()=>void run(p=>p.atlasStop())}>Stop atlas</button>
    <button onClick={()=>void run(p=>p.atlasRender("light",128,"blob"))}>Atlas Blob Light</button>
    <span style={{fontFamily:"monospace",maxWidth:320,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}} title={JSON.stringify(status)}>{JSON.stringify(status,(_k,v)=>Array.isArray(v)?`${v.length} items`:v)}</span>
  </div>;
}
