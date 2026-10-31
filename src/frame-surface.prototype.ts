// THROWAWAY PROTOTYPE: compare live HTML/capture implementations on the real canvas route.
import type { DesignSystem } from "../shared/types";

export type PrototypeFrame = {
  id: string;
  html: string;
  width: number;
  height: number | null;
  design: DesignSystem;
  theme: string | undefined;
  /** Precompiled CSS shared by all variants. No browser Tailwind JIT during the experiment. */
  css: string;
  cssUrl?: string;
  pixelWidth?: number;
};
export type PrototypeReady = { measuredHeight: number; supported: boolean; reason?: string; domNodes?: number };
export type PrototypeSurface = {
  update(frame: PrototypeFrame): Promise<PrototypeReady>;
  dispose(): void;
};
