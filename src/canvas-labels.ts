/**
 * Canvas labels: one line of text above a node, the same size on screen at every zoom.
 * The raster layer draws them with these metrics and `.frame-label` in styles.css mirrors them,
 * so a label stays put when its node moves between layers.
 */
export const LABEL_LINE = 16;
export const LABEL_GAP = 6;
/** Screen space a label takes above its node. Nested labels hide when the gap above their node is smaller. */
export const LABEL_ROOM = LABEL_LINE + LABEL_GAP;

const FAMILY = '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
export const LABEL_FONT = {
  node: `500 12px ${FAMILY}`,
  family: `600 12px ${FAMILY}`,
  section: `600 13px ${FAMILY}`,
} as const;

/** Metrics measured before the web font arrives belong to a fallback font, so they are not kept. */
const fontsReady = () => typeof document === "undefined" || document.fonts?.status !== "loading";

const baselines = new Map<string, number>();
/** Distance from a node's top edge up to its label's alphabetic baseline, as a CSS line box of LABEL_LINE places it. */
export function labelBaseline(ctx: CanvasRenderingContext2D) {
  let offset = baselines.get(ctx.font);
  if (offset === undefined) {
    const m = ctx.measureText("Hg");
    // CSS centres the font's ascent + descent in the line box; the baseline sits half-leading + descent above its bottom.
    offset = LABEL_GAP + (LABEL_LINE - m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 2;
    if (fontsReady()) baselines.set(ctx.font, offset);
  }
  return offset;
}

const widths = new Map<string, number>();
const width = (ctx: CanvasRenderingContext2D, text: string) => {
  const key = `${ctx.font}\n${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    if (widths.size > 8000) widths.clear();
    if (fontsReady()) widths.set(key, w);
  }
  return w;
};

/** `text` in the context's font, cut with an ellipsis to fit `max` screen pixels, like CSS text-overflow. */
export function fitLabel(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (width(ctx, text) <= max) return text;
  let lo = 0, hi = text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(ctx, text.slice(0, mid) + "…") <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? text.slice(0, lo).trimEnd() + "…" : "";
}
