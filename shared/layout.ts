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
/** Sibling sections tile in about √n columns, so a page grows roughly as wide as it is tall. */
export const sectionColumns = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));
/** About four component catalogs side by side. Flows never tile, so only catalogs and groups of them meet this. */
export const TILE_WIDTH = 8000;
/** Tiled sections may run a quarter past their widest member, so a narrow sheet can sit beside a full-width group. */
export const tileWidth = (widths: number[]) => Math.max(TILE_WIDTH, ...widths.map((w) => w * 1.25));

/**
 * Offsets for a run of sibling sections. They fill about √n columns in order, top to bottom, each column a fixed
 * share of the run, so tall and short groups interleave instead of leaving gaps under a shared row height.
 * Columns come from order, count and widths only: measured heights move sections down within their column but
 * never into another one. Fewer columns are used when they would exceed the tile width.
 */
export function tileSections(sizes: readonly { w: number; h: number }[], gap: number) {
  const n = sizes.length, budget = tileWidth(sizes.map((s) => s.w));
  for (let columns = Math.min(n, sectionColumns(n)); ; columns--) {
    const offsets: { x: number; y: number }[] = [];
    let x = 0, h = 0, start = 0;
    for (let c = 0; c < columns; c++) {
      // Earlier columns take the remainder, so ten sections in four columns stack 3, 3, 2, 2.
      const column = sizes.slice(start, start += Math.floor(n / columns) + (c < n % columns ? 1 : 0));
      let y = 0;
      for (const s of column) { offsets.push({ x, y }); y += s.h + gap; }
      h = Math.max(h, y - gap);
      x += Math.max(...column.map((s) => s.w)) + gap;
    }
    if (x - gap <= budget || columns === 1) return { offsets, w: x - gap, h };
  }
}

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
  // A section with screens, at any depth, is a flow that reads left to right, so it takes a whole row.
  // Other sections (catalogs, token sheets, groups of them) tile together.
  const screens = new Map<string, boolean>();
  const hasScreens = (s: CanvasNode): boolean => {
    if (!screens.has(s.id)) {
      screens.set(s.id, false);
      screens.set(s.id, (kids.get(s.id) ?? []).some((k) => k.kind === "frame" || k.kind === "section" && hasScreens(k)));
    }
    return screens.get(s.id)!;
  };
  /** Consecutive siblings that tile together: one flow alone, or a run of other sections. */
  const runEnd = (sections: CanvasNode[], start: number) => {
    let end = start + 1;
    if (!hasScreens(sections[start]!)) while (end < sections.length && sections[end]!.kind === "section" && !hasScreens(sections[end]!)) end++;
    return end;
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
        // Keep the original slot while a child floats. This prevents the drop target collapsing
        // under the pointer and the rest of the canvas jumping before the drop is committed.
        const place = (i: number, dx: number, dy: number) => {
          const child = children[i]!, cr = inner[i]!;
          if (!(floating?.has(child.id) && !floating.has(f.id))) shift(child, f.x + pad + gutter + dx - cr.x, f.y + pad + dy - cr.y);
        };
        let x = 0, y = 0, rowHeight = 0, columns = 0, width = 0;
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!, cr = inner[i]!;
          if (child.kind === "section") {
            // Nested groups start a new row as one tiled block; the next frame starts another.
            const end = runEnd(children, i), block = tileSections(inner.slice(i, end), rowGap);
            if (columns) { y += rowHeight + rowGap; x = 0; }
            block.offsets.forEach((o, j) => place(i + j, o.x, y + o.y));
            width = Math.max(width, block.w); rowHeight = block.h; columns = 1;
            i = end - 1;
            continue;
          }
          // Catalogs wrap per family instead of after a fixed column count.
          const wraps = catalog
            ? familyOf(child.name) !== familyOf(children[i - 1]?.name ?? "") || x + cr.w > CATALOG_ROW_WIDTH
            : children[i - 1]?.kind === "section" || columns >= AUTO_COLUMNS || x + cr.w > AUTO_ROW_WIDTH;
          if (columns && wraps) {
            y += rowHeight + rowGap; x = 0; rowHeight = 0; columns = 0;
          }
          place(i, x, y);
          width = Math.max(width, x + cr.w);
          rowHeight = Math.max(rowHeight, cr.h);
          x += cr.w + gap; columns++;
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
  // Only explicitly automatic root sections participate. Existing free layouts and loose nodes stay put, and a
  // page that has any keeps its automatic sections in one column, so tiling never grows sideways into them.
  const pages = new Map<string, CanvasNode[]>(), manual = new Set<string>();
  for (const f of frames) {
    if (isManualRoot(f)) manual.add(f.pageId);
    else if (!f.parentId) (pages.get(f.pageId) ?? pages.set(f.pageId, []).get(f.pageId)!).push(f);
  }
  for (const [pageId, roots] of pages) {
    const anchors = roots.filter((f) => !floating?.has(f.id));
    const base = anchors.length ? anchors : roots;
    const sorted = ordered(roots), left = Math.min(...base.map((f) => f.x)), top = Math.min(...base.map((f) => f.y));
    for (let i = 0, y = 0; i < sorted.length;) {
      const run = sorted.slice(i, i = manual.has(pageId) ? i + 1 : runEnd(sorted, i));
      const block = tileSections(run.map((root) => rects.get(root.id)!), SECTION_GAP);
      run.forEach((root, j) => {
        const r = rects.get(root.id)!, at = block.offsets[j]!;
        if (!floating?.has(root.id)) shift(root, left + at.x - r.x, top + y + at.y - r.y);
      });
      y += block.h + SECTION_GAP;
    }
  }
  return rects;
}

/** Top-level content placed by hand: a free section or a loose node. Its page keeps automatic sections in one column. */
export const isManualRoot = (f: CanvasNode) => !f.parentId && !(f.kind === "section" && f.layout === "auto");

/**
 * How one page arranges its automatic top-level sections: tiled, stacked in one column because hand-placed
 * content shares the page (`stackedBy`), or manual when nothing on it is automatic.
 */
export function pageArrangement(pageNodes: readonly CanvasNode[]) {
  const automatic = pageNodes.some((f) => !f.parentId && !isManualRoot(f)), stackedBy = pageNodes.filter(isManualRoot);
  if (!stackedBy.length) return { arrangement: "tiled" as const };
  if (!automatic) return { arrangement: "manual" as const };
  return { arrangement: "stacked" as const, stackedBy };
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

/**
 * Finds a pointer's insertion slot beside the nearest sibling: frames in rows split at horizontal midpoints,
 * sections (stacked in tiled columns or alone in a row) at vertical ones.
 */
function dropIndex(siblings: CanvasNode[], rects: ReadonlyMap<string, Rect>, point: { x: number; y: number }) {
  let nearest = -1, best = Infinity;
  siblings.forEach((node, index) => {
    const r = rects.get(node.id)!;
    const dx = Math.max(r.x - point.x, 0, point.x - r.x - r.w), dy = Math.max(r.y - point.y, 0, point.y - r.y - r.h);
    if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; nearest = index; }
  });
  if (nearest < 0) return siblings.length;
  const node = siblings[nearest]!, r = rects.get(node.id)!;
  const before = node.kind === "section" ? point.y < r.y + r.h / 2 : point.x < r.x + r.w / 2;
  return before ? nearest : nearest + 1;
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
