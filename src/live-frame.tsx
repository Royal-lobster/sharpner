import { useEffect, useMemo, useRef, useState } from "react";
import { PREVIEW_PACE_MESSAGE, type PreviewPaceMessage } from "../shared/preview-pacing";
import { frameDocument, type DesignSystem } from "../shared/types";

type Layer = { doc: string; key: number; ready: boolean; swap: boolean };

/**
 * A live preview that swaps documents without blinking: the shown iframe stays until its
 * replacement has loaded and styled, so a source change never reveals the outdated
 * thumbnail underneath. Only the newest document carries the node id, which is how the
 * canvas routes its auto-height messages. Pass `design` through `scopeDesign`: an edit to a component
 * the document does not use then builds the same document, and nothing swaps.
 * `paused` holds the documents' animation frames while the camera moves, and `share` is the part of the
 * main thread they may use at rest (see `shared/preview-pacing.ts`).
 */
export function LiveFrame({ id, html, design, width, height, paused, share }: { id: string; html: string; design: DesignSystem; width: number; height: number; paused: boolean; share: number }) {
  const doc = useMemo(() => frameDocument(html, { measure: true, pace: true, base: location.origin, design }), [html, design]);
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  const pacing = useRef({ paused, share });
  pacing.current = { paused, share };
  const pace = (frame: HTMLIFrameElement | undefined) => {
    const message: PreviewPaceMessage = { type: PREVIEW_PACE_MESSAGE, ...pacing.current };
    frame?.contentWindow?.postMessage(message, "*");
  };
  useEffect(() => { for (const frame of frames.current.values()) pace(frame); }, [paused, share]);
  const [layers, setLayers] = useState<Layer[]>(() => [{ doc, key: 0, ready: false, swap: false }]);
  const newest = layers[layers.length - 1]!;
  if (newest.doc !== doc) {
    // Replace a still-loading document; keep the one on screen as the backdrop.
    const shown = layers.find((layer) => layer.ready);
    setLayers([...(shown ? [shown] : []), { doc, key: newest.key + 1, ready: false, swap: !!shown }]);
  }
  const reveal = (key: number) => setLayers((current) => {
    const at = current.findIndex((layer) => layer.key === key);
    return at < 0 ? current : [{ ...current[at]!, ready: true }, ...current.slice(at + 1)];
  });
  return layers.map((layer) => {
    const latest = layer === newest;
    return (
      <iframe
        key={layer.key}
        ref={(frame) => { if (frame) frames.current.set(layer.key, frame); else frames.current.delete(layer.key); }}
        data-id={latest ? id : undefined}
        title={id}
        aria-hidden={latest ? undefined : true}
        tabIndex={latest ? undefined : -1}
        sandbox="allow-scripts"
        srcDoc={layer.doc}
        // A first preview fades in over its thumbnail; a replacement swaps in one frame, with nothing between.
        style={{ width, height, opacity: layer.ready ? 1 : 0, zIndex: latest ? 1 : 0, transition: layer.swap ? "none" : undefined }}
        // Give Tailwind a beat to generate styles before swapping the previous view out.
        // A new document learns its share, and starts paused if the camera is moving.
        onLoad={(event) => { pace(event.currentTarget); setTimeout(() => reveal(layer.key), 120); }}
      />
    );
  });
}
