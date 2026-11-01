// THROWAWAY: show one real server atlas through the existing canvas camera. No new persisted format.
type Camera={x:number;y:number;z:number};
type Node={id:string;x:number;y:number;width:number;height:number|null};
type Rect={id:string;x:number;y:number;w:number;h:number;sourceWidth:number;sourceHeight:number};
export async function createAtlasOverview(data:{imageBase64:string;rects:Rect[]},nodes:Node[]){
  const image=new Image();image.src=`data:image/webp;base64,${data.imageBase64}`;await image.decode();
  const element=document.createElement("canvas");element.style.cssText="position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  const clips=new Map(data.rects.map(r=>[r.id,r]));
  const camera=(cam:Camera,size:{w:number;h:number})=>{
    const dpr=devicePixelRatio;element.width=Math.round(size.w*dpr);element.height=Math.round(size.h*dpr);
    const ctx=element.getContext("2d")!;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,size.w,size.h);ctx.imageSmoothingQuality="high";
    for(const node of nodes){const r=clips.get(node.id);if(!r)continue;const x=node.x*cam.z+cam.x,y=node.y*cam.z+cam.y,w=node.width*cam.z,h=(node.height??r.sourceHeight)*cam.z;
      if(x+w<0||y+h<0||x>size.w||y>size.h)continue;
      const scale=w/r.w,sourceHeight=Math.min(r.h,h/scale);ctx.drawImage(image,r.x,r.y,r.w,sourceHeight,x,y,w,sourceHeight*scale);
    }
  };
  return {element,camera,decodedPixels:image.naturalWidth*image.naturalHeight,dispose:()=>{element.remove();image.src="";}};
}
