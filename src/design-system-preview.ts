import { frameDocument, type DesignSystem } from "../shared/types";

/** Fit the complete interactive viewport, including wide or tall primitives, without inner scrolling. */
export function fitPreview(available: number, width: number, height: number) {
  const scale = Math.min(1, Math.max(1, available) / Math.max(1, width));
  return { scale, height: Math.ceil(height * scale) };
}

/** Private to the document; the canvas and thumbnail renderer keep their own sizing pipeline. */
export function primitivePreviewDocument(tag: string, definition: string | null | undefined, design: DesignSystem, theme: string, session: string) {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return frameDocument(`<style>html,body{overflow:hidden}main{box-sizing:border-box;display:grid;place-items:center;width:max-content;min-width:100%;min-height:160px;padding:24px;background:var(--color-background,#fff);color:var(--color-foreground,#222);font-family:var(--font-sans,system-ui)}</style><main><${tag} data-sharpner-definition="${escape(definition ?? "")}"></${tag}></main><script>(()=>{
    const session=${JSON.stringify(session).replace(/</g, "\\u003c")};
    addEventListener('load',async()=>{
      await document.fonts.ready;
      const main=document.querySelector('main');let previous='';
      const measure=()=>{const width=Math.ceil(main.getBoundingClientRect().width),height=Math.ceil(main.getBoundingClientRect().height),key=width+':'+height;if(key===previous)return;previous=key;parent.postMessage({sharpnerPreview:{session,width,height}},'*')};
      new ResizeObserver(measure).observe(main);
      requestAnimationFrame(()=>requestAnimationFrame(measure));
    });
  })()</script>`, { base: location.origin, design, theme });
}
