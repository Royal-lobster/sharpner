import { useMemo, useState } from "react";
import { frameDocument, type DesignSystem } from "../shared/types";

type Layer = { doc: string; key: number; ready: boolean; swap: boolean };

/**
 * A live preview that swaps documents without blinking: the shown iframe stays until its
 * replacement has loaded and styled, so a source change never reveals the outdated
 * thumbnail underneath. Only the newest document carries the node id, which is how the
 * canvas routes its auto-height messages.
 */
export function LiveFrame({ id, html, design, width, height }: { id: string; html: string; design: DesignSystem; width: number; height: number }) {
  const doc = useMemo(() => frameDocument(html, { measure: true, base: location.origin, design }), [html, design]);
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
        data-id={latest ? id : undefined}
        title={id}
        aria-hidden={latest ? undefined : true}
        tabIndex={latest ? undefined : -1}
        sandbox="allow-scripts"
        srcDoc={layer.doc}
        // A first preview fades in over its thumbnail; a replacement swaps in one frame, with nothing between.
        style={{ width, height, opacity: layer.ready ? 1 : 0, zIndex: latest ? 1 : 0, transition: layer.swap ? "none" : undefined }}
        // Give Tailwind a beat to generate styles before swapping the previous view out.
        onLoad={() => setTimeout(() => reveal(layer.key), 120)}
      />
    );
  });
}
