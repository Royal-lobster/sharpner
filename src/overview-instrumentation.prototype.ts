// THROWAWAY measurement hooks in the actual canvas painter.
export type OverviewDraw={id:string;kind:string;rev:number;theme?:string;current:boolean;painted:boolean;x:number;y:number;w:number;h:number};
export const overviewInstrumentation:{draw?:(rows:OverviewDraw[],size:{w:number;h:number})=>void;sharedActive?:boolean;cameraObserver?:(cam:{x:number;y:number;z:number},size:{w:number;h:number})=>void;canvas?:{cam:{x:number;y:number;z:number};size:{w:number;h:number};live:number;fit:()=>void;setCam:(c:{x:number;y:number;z:number})=>void}}={};
