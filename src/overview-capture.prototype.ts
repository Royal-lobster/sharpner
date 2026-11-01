// THROWAWAY: capture an already-ready opaque document. No iframe creation, fetch, or origin relaxation.
// A successful bitmap is a capability result, not a pixel-fidelity guarantee; compare reference captures.
export type OverviewCaptureStats = {
  totalMs: number; fontWaitMs: number; serializeMs: number; decodeMs: number; encodeMs: number;
  nodes: number; serializedBytes: number; outputBytes: number; prunedFontFaces: number; prunedFontBytes: number;
};
export type OverviewCaptureResult = {
  ok: boolean; dataUrl?: string; width: number; height: number; measuredHeight: number;
  stats: OverviewCaptureStats; unsupported: string[];
  debugSvg?: string;
};
export type OverviewCaptureOptions = {
  width: number; height: number | null; targetWidth?: number; canonicalTimeMs?: number;
  /** Every external URL must resolve to a caller-prepared data URL. This bridge never fetches. */
  assets?: Record<string, string>;
  /** Trusted parent's exact compiled CSS replaces only these known live stylesheet URLs. */
  styles?: string; styleUrls?: string[];
  debugSvg?: boolean;
  deadlineMs?: number; syncBudgetMs?: number;
};

/** Stringify this function into the warm frame; every dependency deliberately lives inside it. */
export function overviewCaptureBridge(token: string) {
  const MAX_NODES = 3000, MAX_BYTES = 2 * 1024 * 1024, MAX_RAW_CHARS = 4 * 1024 * 1024;
  type Job = { seq: number; cancelled: boolean; cancelDecode?: () => void };
  let active: Job | null = null;
  const blankStats = (): OverviewCaptureStats => ({totalMs:0,fontWaitMs:0,serializeMs:0,decodeMs:0,encodeMs:0,nodes:0,serializedBytes:0,outputBytes:0,prunedFontFaces:0,prunedFontBytes:0});
  const reply = (seq: number, result: OverviewCaptureResult) => parent.postMessage({type:"overview-capture-result",token,seq,result},"*");
  const xml = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const base64 = (bytes: Uint8Array) => {
    let binary="";for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(binary);
  };
  const run = async (job: Job, options: OverviewCaptureOptions): Promise<OverviewCaptureResult> => {
    const start=performance.now(),stats=blankStats();
    const deadline=start+Math.max(100,Math.min(4000,options.deadlineMs??1500));
    let width=Math.max(1,Math.min(4000,Math.round(options.width))),height=1,measuredHeight=1;
    const check=()=>{if(job.cancelled)throw new Error("cancelled");if(performance.now()>deadline)throw new Error("capture-deadline");};
    const fail=(reason:string):OverviewCaptureResult=>({ok:false,width,height,measuredHeight,stats:{...stats,totalMs:performance.now()-start},unsupported:[reason]});
    let restoreAnimations=()=>{};
    try {
      if(!Number.isFinite(options.width)||options.width<=0||options.height!==null&&(!Number.isFinite(options.height)||options.height<=0))throw new Error("invalid-geometry");
      if(document.readyState==="loading"||!document.body)throw new Error("document-not-ready");
      if(Math.abs(innerWidth-width)>1)throw new Error("capture-width-does-not-match-warm-viewport");
      const elements=[document.documentElement,...document.documentElement.querySelectorAll("*")];stats.nodes=elements.length;
      if(elements.length>MAX_NODES)throw new Error("dom-node-limit");
      if(document.documentElement.outerHTML.length>MAX_RAW_CHARS)throw new Error("source-size-limit");
      const excluded=document.querySelector("canvas,video,audio,iframe,object,embed");
      if(excluded)throw new Error(`unsupported-element:${excluded.localName}`);
      if(document.querySelector("dialog[open],[popover]:popover-open"))throw new Error("top-layer-content");
      const assets=options.assets??{};
      if(Object.keys(assets).length>64)throw new Error("resource-count-limit");
      const styleUrls=new Set((options.styleUrls??[]).map(url=>new URL(url,document.baseURI).href));
      if(styleUrls.size>8||options.styles&&options.styles.length>MAX_RAW_CHARS)throw new Error("stylesheet-size-limit");
      const resolveResource=(input:string)=>{
        if(input.startsWith("#")||input.startsWith("data:"))return input;
        const url=new URL(input,document.baseURI).href,data=assets[url]??assets[input];
        if(!data?.startsWith("data:"))throw new Error(`unembedded-resource:${url.slice(0,180)}`);
        if(data.length>MAX_BYTES)throw new Error("resource-size-limit");
        return data;
      };
      const fontStart=performance.now();document.body.getBoundingClientRect();
      const loading=[...document.fonts].filter(face=>face.status==="loading");
      if(loading.length)await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("fonts-not-ready")),Math.max(1,Math.min(500,deadline-performance.now())));
        Promise.all(loading.map(face=>face.loaded)).then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);reject(new Error("font-load-failed"));});
      });
      if([...document.fonts].some(face=>face.status==="loading"||face.status==="error"))throw new Error("fonts-not-ready");
      stats.fontWaitMs=performance.now()-fontStart;check();
      // Freeze and clone synchronously, then restore before image decode. No visible document is
      // held at its poster time for the asynchronous decode/encode work. This does not pause JS.
      const animationStates=document.getAnimations().map(animation=>({animation,time:animation.currentTime,state:animation.playState}));
      restoreAnimations=()=>{for(const {animation,time,state} of animationStates){try{animation.currentTime=time;if(state==="running")animation.play();else if(state==="paused")animation.pause();}catch{/* A replaced effect cannot be restored. */}}};
      for(const {animation} of animationStates){animation.pause();if(options.canonicalTimeMs!==undefined)animation.currentTime=Math.max(0,options.canonicalTimeMs);}
      const serializeStart=performance.now(),syncDeadline=Math.min(deadline,serializeStart+Math.max(5,Math.min(50,options.syncBudgetMs??40)));
      const syncCheck=()=>{check();if(performance.now()>syncDeadline)throw new Error("synchronous-serialization-budget");};
      measuredHeight=Math.ceil(document.body.getBoundingClientRect().height);
      height=Math.max(1,Math.min(8000,Math.round(options.height??measuredHeight)));
      const copy=document.documentElement.cloneNode(true) as HTMLElement;
      copy.setAttribute("xmlns","http://www.w3.org/1999/xhtml");
      const clones=[copy,...copy.querySelectorAll("*")];
      const family=(value:string)=>value.trim().replace(/^(["'])(.*)\1$/,"$2").toLowerCase();
      const descriptor=(value:string,fallback:string)=>(value.trim()||fallback).toLowerCase().replace(/\s+/g," ");
      const faceKey=(value:{family:string;weight:string;style:string;stretch:string;unicodeRange:string})=>JSON.stringify([
        family(value.family),descriptor(value.weight,"normal").replace(/\bnormal\b/g,"400").replace(/\bbold\b/g,"700"),descriptor(value.style,"normal"),descriptor(value.stretch,"normal").replace(/\bnormal\b/g,"100%"),(value.unicodeRange||"U+0-10FFFF").toUpperCase().replace(/\s+/g,""),
      ]);
      const fontStates=new Map<string,string[]>();
      for(const face of document.fonts){const key=faceKey(face),states=fontStates.get(key)??[];states.push(face.status);fontStates.set(key,states);}
      const matchedFonts=new Set<string>();
      const rewriteCss=(css:string)=>{
        if(/@import\b/i.test(css))throw new Error("unembedded-css-import");
        if(/:root\s*[>+~]/i.test(css))throw new Error("root-relationship-selector");
        if(height!==innerHeight&&/@media[^{]*\b(?:min-|max-)?height\s*:/i.test(css))throw new Error("height-media-query-needs-viewport-capture");
        return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/g,(_whole,a:string,b:string,c:string)=>`url("${resolveResource(a??b??c).replace(/"/g,"\\\"")}")`);
      };
      const rulesText=(rules:CSSRuleList):string=>[...rules].map(rule=>{
        if(rule.type===CSSRule.FONT_FACE_RULE){
          const style=(rule as CSSFontFaceRule).style,key=faceKey({family:style.getPropertyValue("font-family"),weight:style.getPropertyValue("font-weight"),style:style.getPropertyValue("font-style"),stretch:style.getPropertyValue("font-stretch"),unicodeRange:style.getPropertyValue("unicode-range")});
          matchedFonts.add(key);const states=fontStates.get(key);
          if(states?.length&&states.every(state=>state==="unloaded")){stats.prunedFontFaces++;stats.prunedFontBytes+=rule.cssText.length;return "";}
          if(/\blocal\(/i.test(style.getPropertyValue("src")))throw new Error("local-font-face-requires-fidelity-check");
        }
        if("cssRules" in rule&&!("style" in rule)){
          const grouping=rule as CSSGroupingRule;
          return rule.cssText.slice(0,rule.cssText.indexOf("{"))+"{"+rulesText(grouping.cssRules)+"}";
        }
        return rewriteCss(rule.cssText);
      }).join("\n");
      const frozen=["width","height","min-width","min-height","max-width","max-height","top","right","bottom","left","font-family","font-size","font-weight","line-height","letter-spacing","margin-top","margin-right","margin-bottom","margin-left","padding-top","padding-right","padding-bottom","padding-left","transform","transform-origin","box-shadow","text-shadow","opacity","color","background-color","border-top-color","border-right-color","border-bottom-color","border-left-color","clip-path"];
      const checkStyle=(style:CSSStyleDeclaration)=>{
        if(style.position==="fixed"||style.position==="sticky")throw new Error(`unsupported-position:${style.position}`);
        if(style.filter&&style.filter!=="none"||style.backdropFilter&&style.backdropFilter!=="none")throw new Error("filter-requires-browser-reference");
        if(style.mixBlendMode&&style.mixBlendMode!=="normal")throw new Error("blend-mode-requires-browser-reference");
        for(const property of ["background-image","mask-image","border-image-source","list-style-image","content","clip-path","fill","stroke"]){const value=style.getPropertyValue(property);if(value.includes("url("))rewriteCss(value);}
      };
      let pseudoCss="";
      let replacedStyles=false;
      for(let i=0;i<elements.length;i++){
        if(i%16===0)syncCheck();const original=elements[i]!,clone=clones[i]!;
        if(["script","base","meta"].includes(original.localName)){clone.remove();continue;}
        if(original.localName==="link"){
          const link=original as HTMLLinkElement;
          if(link.relList.contains("stylesheet")&&!link.disabled){
            if(!options.styles||!styleUrls.has(link.href))throw new Error("external-stylesheet-not-inlined");
            if(!link.sheet)throw new Error("shared-stylesheet-not-loaded");
            if(replacedStyles)throw new Error("multiple-shared-stylesheet-order-ambiguous");
            const sheet=new CSSStyleSheet();sheet.replaceSync(options.styles);
            const style=document.createElement("style");style.textContent=rulesText(sheet.cssRules);
            if(link.media)style.media=link.media;
            clone.parentNode!.replaceChild(style,clone);replacedStyles=true;continue;
          }
          clone.remove();continue;
        }
        if(original instanceof HTMLStyleElement){
          if(original.type==="text/tailwindcss"){clone.remove();continue;}
          if(!original.sheet)throw new Error("stylesheet-not-ready");
          try{clone.textContent=rulesText(original.sheet.cssRules);}catch(error){throw error instanceof Error?error:new Error("unreadable-stylesheet");}
          continue;
        }
        if(original.shadowRoot)throw new Error("shadow-root-not-serialized");
        if(original.scrollTop||original.scrollLeft)throw new Error("scrolled-content-needs-explicit-poster");
        for(const name of clone.getAttributeNames())if(/^on/i.test(name))clone.removeAttribute(name);
        const style=getComputedStyle(original);checkStyle(style);
        if(clone instanceof HTMLElement||clone instanceof SVGElement){
          for(const property of frozen)clone.style.setProperty(property,style.getPropertyValue(property),"important");
          clone.style.setProperty("animation","none","important");clone.style.setProperty("transition","none","important");
          for(const property of ["background-image","mask-image","border-image-source","list-style-image"]){const value=style.getPropertyValue(property);if(value.includes("url("))clone.style.setProperty(property,rewriteCss(value),"important");}
        }
        for(const pseudo of ["::before","::after"]){
          const state=getComputedStyle(original,pseudo);if(["","none","normal"].includes(state.content))continue;
          checkStyle(state);clone.setAttribute("data-overview-capture",String(i));
          pseudoCss+=`[data-overview-capture="${i}"]${pseudo}{${frozen.concat(["top","right","bottom","left","content"]).map(property=>`${property}:${rewriteCss(state.getPropertyValue(property))}!important`).join(";")}}`;
        }
        if(original instanceof HTMLImageElement){
          if(!original.complete||!original.naturalWidth)throw new Error("image-not-ready");
          clone.removeAttribute("srcset");clone.removeAttribute("sizes");clone.setAttribute("src",resolveResource(original.currentSrc||original.src));
        }
        if(original instanceof SVGImageElement){const href=original.href.baseVal;if(href)clone.setAttribute("href",resolveResource(href));}
        if(original instanceof SVGUseElement){const href=original.href.baseVal;if(href&&!href.startsWith("#"))throw new Error("external-svg-use");}
        if(original instanceof HTMLInputElement){clone.setAttribute("value",original.value);if(original.checked)clone.setAttribute("checked","");else clone.removeAttribute("checked");}
        if(original instanceof HTMLTextAreaElement)clone.textContent=original.value;
        if(original instanceof HTMLOptionElement){if(original.selected)clone.setAttribute("selected","");else clone.removeAttribute("selected");}
      }
      if(options.styles&&!replacedStyles)throw new Error("shared-stylesheet-not-found");
      syncCheck();
      for(const [key,states] of fontStates)if(states.some(state=>state==="loaded")&&!matchedFonts.has(key))throw new Error("loaded-font-has-no-serializable-face");
      const freeze=document.createElement("style");freeze.textContent=`*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}${pseudoCss}`;copy.querySelector("head")!.appendChild(freeze);
      const root=getComputedStyle(document.documentElement),rootVars=[...root].filter(property=>property.startsWith("--")).map(property=>`${property}:${root.getPropertyValue(property)}`).join(";");
      const rootAttributes=[...document.documentElement.attributes].filter(attribute=>attribute.name==="class"||attribute.name.startsWith("data-")).map(attribute=>`${attribute.name}="${xml(attribute.value)}"`).join(" ");
      const html=new XMLSerializer().serializeToString(copy);
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttributes} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="font-size:${xml(root.fontSize)};${xml(rootVars)};width:${width}px!important;height:${height}px!important"><foreignObject width="${width}" height="${height}">${html}</foreignObject></svg>`;
      stats.serializedBytes=new TextEncoder().encode(svg).byteLength;stats.serializeMs=performance.now()-serializeStart;
      syncCheck();
      restoreAnimations();restoreAnimations=()=>{};check();
      if(stats.serializedBytes>MAX_BYTES)throw new Error("serialized-byte-limit");
      const image=new Image(),decodeStart=performance.now();
      await new Promise<void>((resolve,reject)=>{
        const finish=(error?:Error)=>{clearTimeout(timer);image.onload=image.onerror=null;job.cancelDecode=undefined;if(error){image.src="";reject(error);}else resolve();};
        const timer=setTimeout(()=>finish(new Error("image-decode-deadline")),Math.max(1,deadline-performance.now()));
        job.cancelDecode=()=>finish(new Error("cancelled"));image.onload=()=>finish();image.onerror=()=>finish(new Error("foreignobject-image-rejected"));
        image.src=`data:image/svg+xml;base64,${base64(new TextEncoder().encode(svg))}`;
      });
      stats.decodeMs=performance.now()-decodeStart;check();
      const targetWidth=Math.max(1,Math.min(width,1280,Math.round(options.targetWidth??256)));
      const canvas=document.createElement("canvas");canvas.width=targetWidth;canvas.height=Math.max(1,Math.round(height*targetWidth/width));
      const ctx=canvas.getContext("2d")!;ctx.imageSmoothingQuality="high";
      const encodeStart=performance.now();ctx.drawImage(image,0,0,canvas.width,canvas.height);
      // Tainted or browser-declined readback is a hard failure. No parent-origin workaround.
      ctx.getImageData(0,0,1,1);const dataUrl=canvas.toDataURL("image/webp",.75);image.src="";
      stats.encodeMs=performance.now()-encodeStart;check();
      if(!dataUrl.startsWith("data:image/webp;base64,"))throw new Error("webp-encode-not-supported");
      if(dataUrl.length>MAX_BYTES)throw new Error("encoded-output-byte-limit");
      const encoded=dataUrl.slice(dataUrl.indexOf(",")+1);
      stats.outputBytes=encoded.length*3/4-(encoded.endsWith("==")?2:encoded.endsWith("=")?1:0);stats.totalMs=performance.now()-start;
      return {ok:true,dataUrl,width,height,measuredHeight,stats,unsupported:[],...(options.debugSvg?{debugSvg:svg}:{})};
    } catch(error){return fail(error instanceof Error?error.message:String(error));}
    finally{restoreAnimations();}
  };
  addEventListener("message",event=>{
    if(event.source!==parent||event.data?.token!==token||!Number.isSafeInteger(event.data.seq))return;
    const {seq}=event.data;
    if(event.data.type==="overview-capture-cancel"){if(active&&active.seq===seq){active.cancelled=true;active.cancelDecode?.();}return;}
    if(event.data.type!=="overview-capture")return;
    if(active){reply(seq,{ok:false,width:0,height:0,measuredHeight:0,stats:blankStats(),unsupported:["capture-already-active"]});return;}
    const job:Job={seq,cancelled:false};active=job;
    void run(job,event.data).then(result=>reply(seq,result)).finally(()=>{if(active===job)active=null;});
  });
  const announce=()=>parent.postMessage({type:"overview-capture-ready",token},"*");
  if(document.readyState==="loading")addEventListener("DOMContentLoaded",announce,{once:true});else announce();
}

let nextCapture = 0;
/** Parent helper. The caller owns pool admission and passes a warm frame with the bridge installed. */
export function captureWarmOverviewFrame(frame: HTMLIFrameElement, token: string, options: OverviewCaptureOptions, signal?: AbortSignal): Promise<OverviewCaptureResult> {
  const seq=++nextCapture;
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);removeEventListener("message",receive);signal?.removeEventListener("abort",abort);};
    const cancel=()=>frame.contentWindow?.postMessage({type:"overview-capture-cancel",token,seq},"*");
    const abort=()=>{cleanup();cancel();reject(signal?.reason??new DOMException("Capture aborted","AbortError"));};
    const receive=(event:MessageEvent)=>{
      const data=event.data;if(event.source!==frame.contentWindow||data?.type!=="overview-capture-result"||data.token!==token||data.seq!==seq)return;
      cleanup();resolve(data.result as OverviewCaptureResult);
    };
    const timer=setTimeout(()=>{cleanup();cancel();reject(new Error("Warm capture response timed out"));},Math.max(100,Math.min(4000,options.deadlineMs??1500))+100);
    addEventListener("message",receive);signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted){abort();return;}
    frame.contentWindow?.postMessage({...options,type:"overview-capture",token,seq},"*");
  });
}
