import { componentName } from "./specimens";
import { specimenWidth, valueLabel, type Specimen } from "./catalog-specimens";
import type { CanvasNode } from "./types";

export type Rect = { x: number; y: number; w: number; h: number };

/** Space between a section's edge and its contents. */
export const SECTION_PAD = 128;
/** Space between neighbours in a row. */
export const AUTO_GAP = 80;
/** Space between rows. Each node's label sits in the gap above it, so rows sit further apart than columns. */
export const AUTO_ROW_GAP = 120;
/** Space between neighbours, rows and tiled sections at the top of a page. */
export const SECTION_GAP = 160;
/** Four desktop screens fit in a row. Flows of smaller screens keep reading left to right until the width runs out. */
export const AUTO_ROW_WIDTH = 6400;
/** Other automatic sections (images, token sheets, mixed previews) stop at four per row. */
export const AUTO_COLUMNS = 4;
/** Sibling sections without screens tile in about √n columns, so a group grows roughly as wide as it is tall. */
export const sectionColumns = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));
/** About four component catalogs side by side. Runs of sections without screens stay within this width. */
export const TILE_WIDTH = 8000;
/** Tiled sections may run a quarter past their widest member, so a narrow sheet can sit beside a full-width group. */
export const tileWidth = (widths: number[]) => Math.max(TILE_WIDTH, ...widths.map((w) => w * 1.25));
/** Width over height that a run of sibling flows aims for: a landscape block, like the screen viewing it. */
export const FLOW_TILE_ASPECT = 1.6;

/**
 * Offsets for a run of sibling sections. They fill about √n columns in order, top to bottom, each column a fixed
 * share of the run, so tall and short groups interleave instead of leaving gaps under a shared row height.
 * Columns come from order, count and widths only: measured heights move sections down within their column but
 * never into another one. Fewer columns are used when they would exceed the tile width.
 */
export function tileSections(sizes: readonly { w: number; h: number }[], gap: number, rowGap = gap) {
  const n = sizes.length, budget = tileWidth(sizes.map((s) => s.w));
  for (let columns = Math.min(n, sectionColumns(n)); ; columns--) {
    const starts: number[] = [];
    // Earlier columns take the remainder, so ten sections in four columns stack 3, 3, 2, 2.
    for (let c = 0, start = 0; c < columns; c++) { starts.push(start); start += Math.floor(n / columns) + (c < n % columns ? 1 : 0); }
    const block = tileColumns(sizes, starts, gap, rowGap);
    if (block.w <= budget || columns === 1) return block;
  }
}

/**
 * Offsets for a run of sibling sections that holds screens. Flows keep their order, top to bottom and then left to
 * right, in columns whose heights balance. The run takes the column count that brings it closest to
 * FLOW_TILE_ASPECT, so a few wide flows stay one per row and many narrow ones sit side by side.
 * Pass `starts` to keep columns chosen earlier; `starts` in the result says where each column begins.
 */
export function tileFlows(sizes: readonly { w: number; h: number }[], gap: number, rowGap = gap, starts?: readonly number[]) {
  if (starts && starts[0] === 0 && starts.every((start, i) => start < sizes.length && (!i || start > starts[i - 1]!))) {
    return { ...tileColumns(sizes, starts, gap, rowGap), starts };
  }
  const heights = sizes.map((s) => s.h);
  const skew = (b: { w: number; h: number }) => Math.abs(Math.log(b.w / Math.max(1, b.h) / FLOW_TILE_ASPECT));
  let best = { ...tileColumns(sizes, [0], gap, rowGap), starts: [0] as readonly number[] };
  // More columns make a run wider and shorter, so the search stops once a run is wider than the target.
  for (let columns = 2; columns <= sizes.length && best.w / Math.max(1, best.h) < FLOW_TILE_ASPECT; columns++) {
    const split = balancedStarts(heights, columns, rowGap), next = { ...tileColumns(sizes, split, gap, rowGap), starts: split };
    if (skew(next) >= skew(best)) break;
    best = next;
  }
  return best;
}

/** Stacks each run of `sizes` that begins at one of `starts` into a column, columns left to right. */
function tileColumns(sizes: readonly { w: number; h: number }[], starts: readonly number[], gap: number, rowGap: number) {
  const offsets: { x: number; y: number }[] = [];
  let x = 0, h = 0;
  starts.forEach((start, c) => {
    const column = sizes.slice(start, starts[c + 1] ?? sizes.length);
    let y = 0;
    for (const s of column) { offsets.push({ x, y }); y += s.h + rowGap; }
    h = Math.max(h, y - rowGap);
    x += Math.max(...column.map((s) => s.w)) + gap;
  });
  return { offsets, w: x - gap, h };
}

/**
 * A component-only section is a catalog: specimens pack tightly, each component family
 * ("Chip" in "Chip/Active") starts its own row, and the family name sits once in a left gutter.
 */
export const CATALOG_PAD = 64;
export const CATALOG_GAP = 40;
export const CATALOG_ROW_GAP = 64;
export const CATALOG_ROW_WIDTH = 1600;
/** Wide enough that a 12px family name of about 12 characters fits at the smallest zoom that shows catalog labels. */
export const CATALOG_GUTTER = 240;
/** Catalogs taller than this multiple of their width split their family rows into columns; shorter ones keep one. */
export const CATALOG_TALL = 1.5;
/** Space between catalog columns. The next column's gutter holds its family names, so this only clears the specimens. */
export const CATALOG_COLUMN_GAP = AUTO_GAP;
/**
 * A family table is a ruled box. Its header row holds the column names; its first column, the catalog gutter, holds
 * the row names. Each cell keeps this much space to the rules around it: half the catalog gap across, less down,
 * since no label sits between rows.
 */
export const TABLE_HEAD = 48;
export const TABLE_PAD_X = CATALOG_GAP / 2;
export const TABLE_PAD_Y = 16;
/** A specimen table's header: one tier for theme names and one for prop values, as the family needs. */
export const SPEC_TIER = 34;
/** Space between small families that share a catalog row. */
export const PACK_GAP = 56;
const EMPTY_SECTION = { w: 480, h: 280 };

/** Height used for layout: fixed, else what a live iframe reported, else the renderer's measurement. */
export const layoutHeight = (f: CanvasNode, live?: Map<string, number>) =>
  f.height ?? live?.get(f.id) ?? f.measuredHeight ?? Math.round(f.width * 0.625);

/**
 * Canvas rectangles for a page's nodes. Every position comes from order and size: a section arranges its children
 * inside its padding, and the page arranges its top-level nodes from the origin the same way. Stored x/y are ignored.
 * Flows pick their columns from stored heights, so heights a live view reports move a flow down its column but never
 * into another one, and every viewer and agent sees the same columns.
 */
export function layoutRects(frames: CanvasNode[], heightOf: (f: CanvasNode) => number) {
  const flowColumns = new Map<string, readonly number[]>();
  const stored = arrangePage(frames, (f) => layoutHeight(f), flowColumns);
  if (frames.every((f) => f.kind === "section" || heightOf(f) === layoutHeight(f))) return stored;
  return arrangePage(frames, heightOf, flowColumns);
}

/** Rects for `frames`. Flow runs use the columns in `flowColumns`, keyed by their first section, or record new ones there. */
function arrangePage(frames: CanvasNode[], heightOf: (f: CanvasNode) => number, flowColumns: Map<string, readonly number[]>) {
  const kids = childrenOf(frames);
  const ids = new Set(frames.map((f) => f.id));
  const rects = new Map<string, Rect>();
  const ordered = inOrder(frames);
  const shift = (f: CanvasNode, dx: number, dy: number, seen = new Set<string>()) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    const r = rects.get(f.id);
    if (r) rects.set(f.id, { ...r, x: r.x + dx, y: r.y + dy });
    for (const k of kids.get(f.id) ?? []) shift(k, dx, dy, seen);
  };
  // A section with screens, at any depth, is a flow that reads left to right. Runs that hold flows tile toward a
  // landscape block; runs of other sections (catalogs, token sheets, groups of them) tile in about √n columns.
  const screens = new Map<string, boolean>();
  const hasScreens = (s: CanvasNode): boolean => {
    if (!screens.has(s.id)) {
      screens.set(s.id, false);
      screens.set(s.id, (kids.get(s.id) ?? []).some((k) => k.kind === "frame" || k.kind === "section" && hasScreens(k)));
    }
    return screens.get(s.id)!;
  };
  /**
   * Offsets for a group's contents in order. Nodes sit in rows: screens wrap only when the row width runs out,
   * other nodes after four. Consecutive sections tile as one block on rows of their own.
   */
  const arrange = (children: CanvasNode[], inner: Rect[], gap: number, rowGap: number) => {
    const flow = children.some((k) => k.kind === "frame");
    const offsets: { x: number; y: number }[] = [];
    let x = 0, y = 0, rowHeight = 0, columns = 0, width = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!, cr = inner[i]!;
      if (child.kind === "section") {
        let end = i + 1;
        while (end < children.length && children[end]!.kind === "section") end++;
        const run = children.slice(i, end), sizes = inner.slice(i, end);
        let block: { offsets: { x: number; y: number }[]; w: number; h: number };
        if (run.some(hasScreens)) {
          const tiled = tileFlows(sizes, gap, rowGap, flowColumns.get(child.id));
          flowColumns.set(child.id, tiled.starts);
          block = tiled;
        } else block = tileSections(sizes, gap, rowGap);
        if (columns) { y += rowHeight + rowGap; x = 0; }
        for (const o of block.offsets) offsets.push({ x: o.x, y: y + o.y });
        width = Math.max(width, block.w); rowHeight = block.h; columns = 1;
        i = end - 1;
        continue;
      }
      const wraps = children[i - 1]?.kind === "section" || !flow && columns >= AUTO_COLUMNS || x + cr.w > AUTO_ROW_WIDTH;
      if (columns && wraps) {
        y += rowHeight + rowGap; x = 0; rowHeight = 0; columns = 0;
      }
      offsets.push({ x, y });
      width = Math.max(width, x + cr.w);
      rowHeight = Math.max(rowHeight, cr.h);
      x += cr.w + gap; columns++;
    }
    return { offsets, w: width, h: y + rowHeight };
  };
  /** Moves each child so its rect starts at its offset from `origin`. */
  const place = (children: CanvasNode[], inner: Rect[], offsets: { x: number; y: number }[], origin: number) =>
    children.forEach((child, i) => shift(child, origin + offsets[i]!.x - inner[i]!.x, origin + offsets[i]!.y - inner[i]!.y));
  const rectOf = (f: CanvasNode, seen = new Set<string>()): Rect => {
    const cached = rects.get(f.id);
    if (cached) return cached;
    let r: Rect;
    if (f.kind !== "section") {
      r = { x: 0, y: 0, w: specimenWidth(f), h: heightOf(f) };
    } else {
      seen.add(f.id);
      const children = ordered((kids.get(f.id) ?? []).filter((k) => !seen.has(k.id)));
      const inner = children.map((k) => rectOf(k, new Set(seen)));
      if (!inner.length) {
        r = { x: 0, y: 0, ...EMPTY_SECTION };
      } else if (isCatalog(children)) {
        const gutter = children.some((k) => familyOf(k.name)) ? CATALOG_GUTTER : 0;
        const block = catalogLayout(children.map((k) => k.name), inner, gutter, children.map((k) => k.specimen));
        place(children, inner, block.offsets, CATALOG_PAD);
        r = { x: 0, y: 0, w: block.w + CATALOG_PAD * 2, h: block.h + CATALOG_PAD * 2 };
      } else {
        const block = arrange(children, inner, AUTO_GAP, AUTO_ROW_GAP);
        place(children, inner, block.offsets, SECTION_PAD);
        r = { x: 0, y: 0, w: block.w + SECTION_PAD * 2, h: block.h + SECTION_PAD * 2 };
      }
    }
    rects.set(f.id, r);
    return r;
  };
  for (const f of frames) rectOf(f);
  // Each page arranges its top-level nodes, and any whose section is missing, like a section without padding.
  const pages = new Map<string, CanvasNode[]>();
  for (const f of frames) if (!f.parentId || !ids.has(f.parentId)) (pages.get(f.pageId) ?? pages.set(f.pageId, []).get(f.pageId)!).push(f);
  for (const roots of pages.values()) {
    const sorted = ordered(roots), inner = sorted.map((root) => rects.get(root.id)!);
    place(sorted, inner, arrange(sorted, inner, SECTION_GAP, SECTION_GAP).offsets, 0);
  }
  return rects;
}

/** Sorts nodes by `order`, falling back to their position in `frames`, then id. */
const inOrder = (frames: readonly CanvasNode[]) => {
  const order = new Map(frames.map((f, i) => [f.id, f.order ?? i]));
  return (nodes: readonly CanvasNode[]) => [...nodes].sort((a, b) => order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
};

/**
 * Row and column of a variant named `Family/Row/Column`, such as `Button/Secondary/Large`. Further parts belong to
 * the column. Null for a name with fewer parts.
 */
export function tableCell(name: string) {
  const parts = name.split("/").map((part) => part.trim()).filter(Boolean);
  return parts.length >= 3 ? { row: parts[1]!, column: parts.slice(2).join(" / ") } : null;
}

type FamilyRun = { start: number; end: number; table: { rows: string[]; columns: string[]; cells: { row: number; column: number }[] } | null };

/**
 * Consecutive catalog members of one family. A family is a table when every member names a row and a column and
 * no two share a cell; rows and columns keep the order of their first member.
 */
export function familyRuns(names: readonly string[]): FamilyRun[] {
  const runs: FamilyRun[] = [];
  for (let start = 0; start < names.length;) {
    const family = familyOf(names[start]!);
    let end = start + 1;
    while (end < names.length && familyOf(names[end]!) === family) end++;
    const rows: string[] = [], columns: string[] = [], cells: { row: number; column: number }[] = [], taken = new Set<string>();
    let table = end - start > 1;
    for (let i = start; table && i < end; i++) {
      const cell = tableCell(names[i]!);
      if (!cell || taken.has(`${cell.row}\0${cell.column}`)) { table = false; break; }
      taken.add(`${cell.row}\0${cell.column}`);
      if (!rows.includes(cell.row)) rows.push(cell.row);
      if (!columns.includes(cell.column)) columns.push(cell.column);
      cells.push({ row: rows.indexOf(cell.row), column: columns.indexOf(cell.column) });
    }
    runs.push({ start, end, table: table ? { rows, columns, cells } : null });
    start = end;
  }
  return runs;
}

/** Header tiers a specimen table needs: theme names when it compares themes, prop values when it has an axis. */
export const specimenTiers = (spec: Specimen) =>
  (new Set(spec.columns.map((c) => c.theme)).size > 1 ? 1 : 0) + (spec.columns.some((c) => c.value !== null) ? 1 : 0);

/**
 * Offsets inside a catalog's padding. Each component family ("Chip" in "Chip/Active") is a block that starts its
 * own row and wraps at the row width, with its name in a gutter to the left. A family named `Family/Row/Column` is
 * a table instead: a header row, then one row per row name and one column per column name, each cell left aligned and
 * vertically centred. The table's box starts at the gutter, which holds its row names. A family whose specimens show
 * several cells (themes side by side, prop values) is a specimen table: its members stack as rows under a header of
 * theme and value names, and each specimen draws its own cells.
 * Consecutive small families share a row, each named above its block, so short families don't leave the row empty.
 * A catalog much taller than wide stacks these rows in columns instead, so a long Design System grows as wide as
 * it is tall. Columns keep family order, top to bottom then left to right, and split where their heights balance.
 */
export function catalogLayout(names: readonly string[], sizes: readonly { w: number; h: number }[], gutter: number, specs: readonly (Specimen | null | undefined)[] = []) {
  const blocks: { offsets: { x: number; y: number }[]; w: number; h: number; table: boolean }[] = [];
  for (const { start, end, table } of familyRuns(names)) {
    const offsets: { x: number; y: number }[] = [];
    const spec = specs[start];
    if (table) {
      const widths = table.columns.map(() => 0), heights = table.rows.map(() => 0);
      table.cells.forEach(({ row, column }, k) => {
        const s = sizes[start + k]!;
        widths[column] = Math.max(widths[column]!, s.w);
        heights[row] = Math.max(heights[row]!, s.h);
      });
      const xs = positions(widths, TABLE_PAD_X * 2), ys = positions(heights, TABLE_PAD_Y * 2), top = TABLE_HEAD + TABLE_PAD_Y;
      table.cells.forEach(({ row, column }, k) => offsets.push({ x: xs[column]!, y: top + ys[row]! + (heights[row]! - sizes[start + k]!.h) / 2 }));
      blocks.push({ offsets, w: xs.at(-1)! + widths.at(-1)! + TABLE_PAD_X, h: top + ys.at(-1)! + heights.at(-1)! + TABLE_PAD_Y, table: true });
      continue;
    }
    if (spec && spec.columns.length > 1) {
      let y = specimenTiers(spec) * SPEC_TIER, w = 0;
      for (let i = start; i < end; i++) { offsets.push({ x: 0, y }); y += sizes[i]!.h; w = Math.max(w, sizes[i]!.w); }
      blocks.push({ offsets, w, h: y, table: true });
      continue;
    }
    let x = 0, y = 0, rowHeight = 0, w = 0;
    for (let i = start; i < end; i++) {
      const s = sizes[i]!;
      if (x && x + s.w > CATALOG_ROW_WIDTH) { y += rowHeight + CATALOG_ROW_GAP; x = 0; rowHeight = 0; }
      offsets.push({ x, y });
      w = Math.max(w, x + s.w); rowHeight = Math.max(rowHeight, s.h); x += s.w + CATALOG_GAP;
    }
    blocks.push({ offsets, w, h: y + rowHeight, table: false });
  }
  // Rows of blocks: small consecutive families share one; a table after the first brings its own gutter for row names.
  const rows: { blocks: { index: number; x: number }[]; w: number; h: number }[] = [];
  const small = (b: (typeof blocks)[number]) => b.w + (b.table ? gutter : 0) <= CATALOG_ROW_WIDTH / 2;
  blocks.forEach((b, index) => {
    const row = rows.at(-1), last = row?.blocks.at(-1);
    const x = row ? row.w + PACK_GAP + (b.table ? gutter : 0) : 0;
    if (row && last && small(blocks[last.index]!) && small(b) && x + b.w <= CATALOG_ROW_WIDTH) {
      row.blocks.push({ index, x }); row.w = x + b.w; row.h = Math.max(row.h, b.h);
    } else rows.push({ blocks: [{ index, x: 0 }], w: b.w, h: b.h });
  });
  const arrange = (starts: number[]) => {
    const offsets: { x: number; y: number }[] = [];
    let x = 0, h = 0;
    starts.forEach((start, c) => {
      const column = rows.slice(start, starts[c + 1] ?? rows.length);
      let y = 0;
      for (const row of column) {
        for (const { index, x: bx } of row.blocks) for (const o of blocks[index]!.offsets) offsets.push({ x: x + gutter + bx + o.x, y: y + o.y });
        y += row.h + CATALOG_ROW_GAP;
      }
      h = Math.max(h, y - CATALOG_ROW_GAP);
      x += gutter + Math.max(...column.map((r) => r.w)) + CATALOG_COLUMN_GAP;
    });
    return { offsets, w: x - CATALOG_COLUMN_GAP, h };
  };
  let best = arrange([0]);
  if (best.h <= best.w * CATALOG_TALL) return best;
  // Closest to square wins, within the same width budget as tiled sections.
  const skew = (a: { w: number; h: number }) => Math.abs(Math.log(a.w / a.h));
  for (let columns = 2; columns <= rows.length; columns++) {
    const next = arrange(balancedStarts(rows.map((r) => r.h), columns, CATALOG_ROW_GAP));
    if (next.w > TILE_WIDTH) break;
    if (skew(next) < skew(best)) best = next;
  }
  return best;
}

/** Where each of a run of lengths starts when they sit `gap` apart. */
const positions = (lengths: readonly number[], gap: number) => {
  const out: number[] = [];
  let at = 0;
  for (const length of lengths) { out.push(at); at += length + gap; }
  return out;
};

/**
 * First index of each of `columns` contiguous runs of `heights`, chosen so the tallest run (with gaps between
 * members) is as short as possible, then so the runs are as even as possible. Remaining ties make the last run the shortest.
 */
export function balancedStarts(heights: readonly number[], columns: number, gap: number) {
  const n = heights.length, sum = [0];
  for (const h of heights) sum.push(sum.at(-1)! + h);
  const run = (i: number, j: number) => sum[j]! - sum[i]! + (j - i - 1) * gap;
  // best[c][j]: the tallest run, then the sum of squared runs, when the first j heights fill c columns.
  type Cost = { tallest: number; spread: number; from: number };
  const best: Cost[][] = [Array.from({ length: n + 1 }, (_, j) => ({ tallest: j ? Infinity : 0, spread: 0, from: 0 }))];
  for (let c = 1; c <= columns; c++) {
    best.push(Array.from({ length: n + 1 }, () => ({ tallest: Infinity, spread: Infinity, from: 0 })));
    for (let j = c; j <= n; j++) {
      for (let i = c - 1; i < j; i++) {
        const prev = best[c - 1]![i]!, h = run(i, j), cur = best[c]![j]!;
        const tallest = Math.max(prev.tallest, h), spread = prev.spread + h * h;
        if (tallest < cur.tallest || tallest === cur.tallest && spread <= cur.spread) best[c]![j] = { tallest, spread, from: i };
      }
    }
  }
  const starts: number[] = [];
  for (let c = columns, j = n; c > 0; c--) starts.unshift(j = best[c]![j]!.from);
  return starts;
}

const isCatalog = (children: CanvasNode[]) => children.length > 0 && children.every((k) => k.kind === "component");

/** "Chip" for "Chip/Active"; empty for a name without a family. Matches the specimens' componentName. */
export const familyOf = (name: string) => name.includes("/") ? componentName(name).family : "";

/** Sections laid out as a catalog. */
export function catalogSectionIds(frames: CanvasNode[]) {
  const ids = new Set<string>();
  const sections = new Set(frames.filter((f) => f.kind === "section").map((f) => f.id));
  for (const [id, children] of childrenOf(frames)) if (sections.has(id) && isCatalog(children)) ids.add(id);
  return ids;
}

/**
 * Text the canvas draws in a catalog rather than above each specimen. A family name heads its block: in the gutter
 * beside a row of variants, above a block that shares its row, or above a table's box. A family's usage note (its
 * first member's description) follows the name: under it in the gutter, after it elsewhere. A table centres each
 * column name in its header row and each row name in the gutter beside its row; a specimen table also names its
 * theme groups. `w` is the room the text may take; `group`, `row` and `column` text is centred on `y`.
 */
export type CatalogLabel = { kind: "family" | "row" | "column" | "group"; text: string; x: number; y: number; w: number; note?: string; noteBelow?: boolean };

/**
 * A family table's box, the y of the rule under its header and of each rule between rows, and the x of each rule
 * between columns. Specimens draw the rules between their own cells, so a specimen table rules its header only:
 * `headColumns` run from `top` down to `head`.
 */
export type CatalogTable = Rect & { head: number; rows: number[]; columns: number[]; headColumns?: { x: number; top: number }[] };

/** Catalog labels and table rules, plus the specimens inside tables, whose headers name them in place of their own labels. */
export function catalogLabels(frames: CanvasNode[], rects: ReadonlyMap<string, Rect>, catalogs: ReadonlySet<string>) {
  const labels: CatalogLabel[] = [], tables: CatalogTable[] = [], cells = new Set<string>();
  const kids = childrenOf(frames), ordered = inOrder(frames);
  for (const id of catalogs) {
    if (!rects.has(id)) continue;
    const members = ordered(kids.get(id) ?? []);
    let previous: Rect | null = null;
    for (const { start, end, table } of familyRuns(members.map((node) => node.name))) {
      const placed = members.slice(start, end).flatMap((node, k) => rects.has(node.id) ? [{ node, rect: rects.get(node.id)!, cell: table?.cells[k] }] : []);
      const family = familyOf(placed[0]?.node.name ?? "");
      if (!placed.length) continue;
      const note = placed.map((p) => p.node.description?.trim()).find(Boolean);
      const left = Math.min(...placed.map((p) => p.rect.x)), top = Math.min(...placed.map((p) => p.rect.y));
      const right = Math.max(...placed.map((p) => p.rect.x + p.rect.w)), bottom = Math.max(...placed.map((p) => p.rect.y + p.rect.h));
      const spec = placed[0]!.node.specimen;
      if (!table && spec && spec.columns.length > 1) {
        const tiers = specimenTiers(spec), x = left - CATALOG_GUTTER, y = top - tiers * SPEC_TIER, cw = spec.cellWidth;
        const values = tiers === 2 || !spec.columns.some((c) => c.theme !== spec.columns[0]!.theme);
        const headColumns: { x: number; top: number }[] = [];
        spec.columns.forEach((c, k) => {
          if (!k) return;
          const group = c.theme !== spec.columns[k - 1]!.theme;
          headColumns.push({ x: left + k * cw, top: group || tiers === 1 ? y : y + SPEC_TIER });
        });
        tables.push({ x, y, w: right - x, h: bottom - y, head: top, rows: [...(tiers === 2 ? [y + SPEC_TIER] : []), ...placed.slice(1).map((p) => p.rect.y)], columns: [left], headColumns });
        labels.push({ kind: "family", text: family || componentName(placed[0]!.node.name).family, x, y, w: right - x, ...(note ? { note } : {}) });
        if (tiers === 2 || !values) {
          let k = 0;
          while (k < spec.columns.length) {
            const theme = spec.columns[k]!.theme;
            let n = 0;
            while (k + n < spec.columns.length && spec.columns[k + n]!.theme === theme) n++;
            labels.push({ kind: "group", text: theme.charAt(0).toUpperCase() + theme.slice(1), x: left + k * cw + TABLE_PAD_X, y: y + SPEC_TIER / 2, w: n * cw - TABLE_PAD_X });
            k += n;
          }
        }
        if (values) spec.columns.forEach((c, k) => labels.push({ kind: "column", text: c.value === null ? "" : valueLabel(c.value), x: left + k * cw + TABLE_PAD_X, y: y + (tiers === 2 ? SPEC_TIER * 1.5 : SPEC_TIER / 2), w: cw - TABLE_PAD_X }));
        for (const p of placed) {
          cells.add(p.node.id);
          labels.push({ kind: "row", text: componentName(p.node.name).variant, x: x + TABLE_PAD_X, y: p.rect.y + p.rect.h / 2, w: CATALOG_GUTTER - TABLE_PAD_X * 3 });
        }
        previous = { x, y, w: right - x, h: bottom - y };
        continue;
      }
      if (!table) {
        // A block beside the previous one on its row is named above itself; a row's first block uses the gutter.
        const beside = previous && Math.abs(previous.y - top) < 1 && previous.x + previous.w <= left;
        if (family) labels.push(beside
          ? { kind: "family", text: family, x: left, y: top, w: right - left, ...(note ? { note } : {}) }
          : { kind: "family", text: family, x: left - CATALOG_GUTTER, y: top, w: CATALOG_GUTTER - 24, ...(note ? { note, noteBelow: true } : {}) });
        previous = { x: left, y: top, w: right - left, h: bottom - top };
        continue;
      }
      for (const p of placed) cells.add(p.node.id);
      // A row's tallest cell and a column's widest one sit on its edges, so placed cells give the exact grid.
      const span = (count: number, pick: (cell: { row: number; column: number }) => number, lo: (r: Rect) => number, hi: (r: Rect) => number) =>
        Array.from({ length: count }, (_, i) => {
          const inside = placed.filter((p) => pick(p.cell!) === i).map((p) => p.rect);
          return inside.length ? { lo: Math.min(...inside.map(lo)), hi: Math.max(...inside.map(hi)) } : null;
        });
      const rows = span(table.rows.length, (c) => c.row, (r) => r.y, (r) => r.y + r.h).filter((r) => r !== null);
      const columns = span(table.columns.length, (c) => c.column, (r) => r.x, (r) => r.x + r.w);
      const shown = columns.filter((c) => c !== null);
      const head = rows[0]!.lo - TABLE_PAD_Y, x = left - CATALOG_GUTTER, y = head - TABLE_HEAD;
      const boxRight = shown.at(-1)!.hi + TABLE_PAD_X, boxBottom = rows.at(-1)!.hi + TABLE_PAD_Y;
      tables.push({
        x, y, w: boxRight - x, h: boxBottom - y, head,
        rows: rows.slice(1).map((r, i) => (rows[i]!.hi + r.lo) / 2),
        columns: [left - TABLE_PAD_X, ...shown.slice(1).map((c, i) => (shown[i]!.hi + c.lo) / 2)],
      });
      labels.push({ kind: "family", text: family, x, y, w: boxRight - x, ...(note ? { note } : {}) });
      columns.forEach((c, i) => { if (c) labels.push({ kind: "column", text: table.columns[i]!, x: c.lo, y: y + TABLE_HEAD / 2, w: c.hi - c.lo + TABLE_PAD_X }); });
      span(table.rows.length, (c) => c.row, (r) => r.y, (r) => r.y + r.h).forEach((r, i) => {
        if (r) labels.push({ kind: "row", text: table.rows[i]!, x: x + TABLE_PAD_X, y: (r.lo + r.hi) / 2, w: CATALOG_GUTTER - TABLE_PAD_X * 3 });
      });
      previous = { x, y, w: boxRight - x, h: boxBottom - y };
    }
  }
  return { labels, tables, cells };
}

export function childrenOf(frames: CanvasNode[]) {
  const kids = new Map<string, CanvasNode[]>();
  for (const f of frames) if (f.parentId) (kids.get(f.parentId) ?? kids.set(f.parentId, []).get(f.parentId)!).push(f);
  return kids;
}

export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
