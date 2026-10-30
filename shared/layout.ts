import { componentName } from "./specimens";
import type { CanvasNode } from "./types";

export type Rect = { x: number; y: number; w: number; h: number };

/** Space between a section's edge and its contents. */
export const SECTION_PAD = 128;
export const AUTO_GAP = 80;
export const SECTION_GAP = 160;
/** Four desktop screens fit in a row; small screens stop at four too. */
export const AUTO_ROW_WIDTH = 6400;
export const AUTO_COLUMNS = 4;
/**
 * A component-only automatic section is a catalog: specimens pack tightly, each component family
 * ("Chip" in "Chip/Active") starts its own row, and the family name sits once in a left gutter.
 */
export const CATALOG_PAD = 64;
export const CATALOG_GAP = 40;
export const CATALOG_ROW_GAP = 64;
export const CATALOG_ROW_WIDTH = 1600;
export const CATALOG_GUTTER = 160;
const EMPTY_SECTION = { w: 480, h: 280 };

/** Height used for layout: fixed, else what a live iframe reported, else the renderer's measurement. */
export const layoutHeight = (f: CanvasNode, live?: Map<string, number>) =>
  f.height ?? live?.get(f.id) ?? f.measuredHeight ?? Math.round(f.width * 0.625);

/**
 * Canvas rectangles for a page's nodes. Sections wrap their children (recursively) with padding;
 * an empty section sits at its own x/y. `floating` nodes (being dragged out) don't stretch their parent.
 */
export function layoutRects(frames: CanvasNode[], heightOf: (f: CanvasNode) => number, floating?: Set<string>) {
  const kids = childrenOf(frames);
  const rects = new Map<string, Rect>();
  const order = new Map(frames.map((f, i) => [f.id, f.order ?? i]));
  const ordered = (nodes: CanvasNode[]) => [...nodes].sort((a, b) => order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
  const shift = (f: CanvasNode, dx: number, dy: number, seen = new Set<string>()) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    const r = rects.get(f.id);
    if (r) rects.set(f.id, { ...r, x: r.x + dx, y: r.y + dy });
    for (const k of kids.get(f.id) ?? []) if (!(floating?.has(k.id) && !floating.has(f.id))) shift(k, dx, dy, seen);
  };
  const rectOf = (f: CanvasNode, seen = new Set<string>()): Rect => {
    const cached = rects.get(f.id);
    if (cached) return cached;
    let r: Rect;
    if (f.kind !== "section") {
      r = { x: f.x, y: f.y, w: f.width, h: heightOf(f) };
    } else {
      seen.add(f.id);
      const children = ordered((kids.get(f.id) ?? [])
        .filter((k) => !seen.has(k.id) && !(f.layout !== "auto" && floating?.has(k.id) && !floating.has(f.id))));
      const inner = children.map((k) => rectOf(k, new Set(seen)));
      if (f.layout === "auto" && inner.length) {
        const catalog = isCatalog(children);
        const pad = catalog ? CATALOG_PAD : SECTION_PAD, gap = catalog ? CATALOG_GAP : AUTO_GAP, rowGap = catalog ? CATALOG_ROW_GAP : AUTO_GAP;
        const gutter = catalog && children.some((k) => familyOf(k.name)) ? CATALOG_GUTTER : 0;
        let x = 0, y = 0, rowHeight = 0, columns = 0, width = 0;
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!, cr = inner[i]!;
          // Nested groups take their own row; their full measured height moves the following group.
          // Catalogs wrap per family instead of after a fixed column count.
          const wraps = catalog
            ? familyOf(child.name) !== familyOf(children[i - 1]?.name ?? "") || x + cr.w > CATALOG_ROW_WIDTH
            : child.kind === "section" || columns >= AUTO_COLUMNS || x + cr.w > AUTO_ROW_WIDTH;
          if (columns && wraps) {
            y += rowHeight + rowGap; x = 0; rowHeight = 0; columns = 0;
          }
          // Keep the original slot while a child floats. This prevents the drop target collapsing
          // under the pointer and the rest of the canvas jumping before the drop is committed.
          if (!(floating?.has(child.id) && !floating.has(f.id))) {
            shift(child, f.x + pad + gutter + x - cr.x, f.y + pad + y - cr.y);
          }
          width = Math.max(width, x + cr.w);
          rowHeight = Math.max(rowHeight, cr.h);
          x += cr.w + gap; columns++;
          if (child.kind === "section" && i < children.length - 1) {
            y += rowHeight + rowGap; x = 0; rowHeight = 0; columns = 0;
          }
        }
        r = { x: f.x, y: f.y, w: gutter + width + pad * 2, h: y + rowHeight + pad * 2 };
      } else {
        r = inner.length ? pad(union(inner), SECTION_PAD) : { x: f.x, y: f.y, ...EMPTY_SECTION };
      }
    }
    rects.set(f.id, r);
    return r;
  };
  for (const f of frames) rectOf(f);
  // Only explicitly automatic root sections participate. Existing free layouts and loose nodes stay put.
  const pages = new Map<string, CanvasNode[]>();
  for (const f of frames) if (!f.parentId && f.kind === "section" && f.layout === "auto") {
    (pages.get(f.pageId) ?? pages.set(f.pageId, []).get(f.pageId)!).push(f);
  }
  for (const roots of pages.values()) {
    const anchors = roots.filter((f) => !floating?.has(f.id));
    const base = anchors.length ? anchors : roots;
    const sorted = ordered(roots), x = Math.min(...base.map((f) => f.x));
    let y = Math.min(...base.map((f) => f.y));
    for (const root of sorted) {
      const r = rects.get(root.id)!;
      if (!floating?.has(root.id)) shift(root, x - r.x, y - r.y);
      y += r.h + SECTION_GAP;
    }
  }
  return rects;
}

const isCatalog = (children: CanvasNode[]) => children.length > 0 && children.every((k) => k.kind === "component");

/** "Chip" for "Chip/Active"; empty for a name without a family. Matches the specimens' componentName. */
export const familyOf = (name: string) => name.includes("/") ? componentName(name).family : "";

/** Automatic sections laid out as a catalog. */
export function catalogSectionIds(frames: CanvasNode[]) {
  const ids = new Set<string>();
  const sections = new Map(frames.map((f) => [f.id, f]));
  for (const [id, children] of childrenOf(frames)) if (sections.get(id)?.layout === "auto" && isCatalog(children)) ids.add(id);
  return ids;
}

/** Where each catalog row's family name goes: the gutter beside the first specimen of each family. */
export function catalogFamilyLabels(frames: CanvasNode[], rects: ReadonlyMap<string, Rect>, catalogs: ReadonlySet<string>) {
  const labels: { family: string; x: number; y: number }[] = [];
  const kids = childrenOf(frames);
  for (const id of catalogs) {
    const section = rects.get(id);
    const placed = (kids.get(id) ?? []).flatMap((node) => rects.has(node.id) ? [{ node, rect: rects.get(node.id)! }] : [])
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    if (!section) continue;
    placed.forEach(({ node, rect }, i) => {
      const family = familyOf(node.name);
      if (family && family !== familyOf(placed[i - 1]?.node.name ?? "")) labels.push({ family, x: section.x + CATALOG_PAD, y: rect.y });
    });
  }
  return labels;
}

/** Nodes whose location is derived from their order rather than their stored x/y. */
export function isManaged(f: CanvasNode, nodes: ReadonlyMap<string, CanvasNode>) {
  if (!f.parentId && f.kind === "section" && f.layout === "auto") return true;
  const seen = new Set<string>();
  let parentId = f.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodes.get(parentId);
    if (parent?.layout === "auto") return true;
    parentId = parent?.parentId ?? null;
  }
  return false;
}

/** Stable fractional orders for a drop in an automatic group, preserving the dragged block's order. */
export function dropOrders(frames: CanvasNode[], rects: Map<string, Rect>, ids: string[], parentId: string | null, pageId: string, point: { x: number; y: number }) {
  const movingIds = new Set(ids);
  const orderById = new Map(frames.map((node, index) => [node.id, node.order ?? index]));
  const siblings = frames.filter((node) => !movingIds.has(node.id) && node.pageId === pageId && node.parentId === parentId &&
    (parentId !== null || node.kind === "section" && node.layout === "auto"))
    .sort((a, b) => orderById.get(a.id)! - orderById.get(b.id)! || a.id.localeCompare(b.id));
  const insertionIndex = dropIndex(siblings, rects, point);

  const before = insertionIndex > 0 ? orderById.get(siblings[insertionIndex - 1]!.id)! : undefined;
  const after = insertionIndex < siblings.length ? orderById.get(siblings[insertionIndex]!.id)! : undefined;
  const low = before ?? (after !== undefined ? after - 1 : -1);
  const high = after ?? low + 1;
  const block = [...ids].sort((a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0));
  const placed = new Map(block.map((id, index) => [id, low + (high - low) * (index + 1) / (ids.length + 1)]));
  const values = [...placed.values()];

  // Repeated insertion into one gap eventually exhausts floating-point precision. Rebalance only
  // that group in the same atomic drop, so ordering stays reliable without rewriting it each time.
  const needsRebalance = values.some((value) => !Number.isFinite(value) || value <= low || value >= high) ||
    new Set(values).size !== values.length;
  if (needsRebalance) {
    const sequence = [
      ...siblings.slice(0, insertionIndex).map((node) => node.id),
      ...block,
      ...siblings.slice(insertionIndex).map((node) => node.id),
    ];
    return new Map(sequence.map((id, index) => [id, (index + 1) * 1024]));
  }
  return placed;
}

/** Finds a pointer's insertion slot: rows use horizontal midpoints, stacked sections use vertical ones. */
function dropIndex(siblings: CanvasNode[], rects: ReadonlyMap<string, Rect>, point: { x: number; y: number }) {
  const rows: CanvasNode[][] = [];
  for (const node of siblings) {
    const lastRow = rows.at(-1);
    if (lastRow && rects.get(lastRow[0]!.id)!.y === rects.get(node.id)!.y) lastRow.push(node);
    else rows.push([node]);
  }
  const first = siblings[0] && rects.get(siblings[0].id);
  const lastRow = rows.at(-1);
  const bottomOf = (row: CanvasNode[]) => Math.max(...row.map((node) => {
    const rect = rects.get(node.id)!;
    return rect.y + rect.h;
  }));
  if (first && point.y < first.y) return 0;
  if (lastRow && point.y > bottomOf(lastRow)) return siblings.length;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, nextRow = rows[index + 1];
    const nextRowBoundary = nextRow ? (bottomOf(row) + rects.get(nextRow[0]!.id)!.y) / 2 : Infinity;
    if (point.y > nextRowBoundary) continue;
    const following = row.find((node) => {
      const rect = rects.get(node.id)!;
      return node.kind === "section" ? point.y < rect.y + rect.h / 2 : point.x < rect.x + rect.w / 2;
    });
    return following ? siblings.indexOf(following) : siblings.indexOf(row.at(-1)!) + 1;
  }
  return siblings.length;
}

export function childrenOf(frames: CanvasNode[]) {
  const kids = new Map<string, CanvasNode[]>();
  for (const f of frames) if (f.parentId) (kids.get(f.parentId) ?? kids.set(f.parentId, []).get(f.parentId)!).push(f);
  return kids;
}

/** All nodes nested (at any depth) inside the given sections. */
export function descendantsOf(frames: CanvasNode[], ids: Iterable<string>) {
  const kids = childrenOf(frames);
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k.id)) { out.add(k.id); stack.push(k.id); }
  }
  return out;
}

export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 });

export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
