import { describe, expect, it } from "vitest";
import { AUTO_GAP, AUTO_ROW_GAP, AUTO_ROW_WIDTH, balancedStarts, CATALOG_COLUMN_GAP, CATALOG_GAP, CATALOG_GUTTER, CATALOG_TALL, CATALOG_PAD, CATALOG_ROW_GAP, catalogLabels, catalogSectionIds, FLOW_TILE_ASPECT, layoutHeight, layoutRects, type Rect, SECTION_GAP, SECTION_PAD, sectionColumns, TABLE_HEAD, TABLE_PAD_X, TABLE_PAD_Y, tileFlows, tileSections } from "./layout";
import type { CanvasNode } from "./types";
import { PACK_GAP, SPEC_TIER } from "./layout";
import { CELL_PAD_X, type Specimen } from "./catalog-specimens";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const section = (id: string, patch: Partial<CanvasNode> = {}) => node(id, { kind: "section", width: 0, height: null, ...patch });
const rectsOf = (nodes: CanvasNode[]) => layoutRects(nodes, layoutHeight);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A group section holding the given nodes: by default one component, which makes it a catalog. */
const group = (id: string, parentId: string | null, order: number, members: Partial<CanvasNode>[] = [{}]) => [
  section(id, { parentId, order }),
  ...members.map((patch, i) => node(`${id}-${i}`, { parentId: id, order: i, kind: "component", ...patch })),
];
/** A catalog group holding one `width` × 600 component. */
const catalogSize = (width: number) => ({ w: width + CATALOG_PAD * 2, h: 600 + CATALOG_PAD * 2 });

/** Family names in the gutter, as `{ family, x, y }`. */
const familyLabels = (nodes: CanvasNode[], rects: Map<string, Rect>) =>
  catalogLabels(nodes, rects, catalogSectionIds(nodes)).labels.filter((l) => l.kind === "family").map(({ text, x, y }) => ({ family: text, x, y }));

describe("component catalogs", () => {
  const component = (id: string, name: string, order: number, patch: Partial<CanvasNode> = {}) =>
    node(id, { parentId: "chips", kind: "component", name, order, width: 200, height: 120, ...patch });

  it("packs a family's variants into one tight row and starts each family on a new row", () => {
    const nodes = [section("chips"), component("active", "Chip/Active", 0), component("default", "Chip/Default", 1),
      ...Array.from({ length: 4 }, (_, i) => component(`more-${i}`, `Chip/More ${i}`, 2 + i)), component("tab", "Tab/Active", 6, { height: 90 })];
    const rects = rectsOf(nodes);
    const left = CATALOG_PAD + CATALOG_GUTTER;
    expect(rects.get("active")).toMatchObject({ x: left, y: CATALOG_PAD });
    expect(rects.get("default")).toMatchObject({ x: left + 200 + CATALOG_GAP, y: CATALOG_PAD });
    // Six chips share a row: catalogs aren't capped at four columns like screens.
    expect(rects.get("more-3")!.y).toBe(CATALOG_PAD);
    expect(rects.get("tab")).toMatchObject({ x: left, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP });
    expect(rects.get("chips")).toMatchObject({ w: CATALOG_GUTTER + 6 * 200 + 5 * CATALOG_GAP + CATALOG_PAD * 2, h: 120 + CATALOG_ROW_GAP + 90 + CATALOG_PAD * 2 });
    expect(familyLabels(nodes, rects)).toEqual([
      { family: "Chip", x: CATALOG_PAD, y: CATALOG_PAD },
      { family: "Tab", x: CATALOG_PAD, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP },
    ]);
  });

  it("wraps a long family at the row width without repeating its name", () => {
    const nodes = [section("chips"), ...Array.from({ length: 4 }, (_, i) => component(`${i}`, `Card/${i}`, i, { width: 600 }))];
    const rects = rectsOf(nodes);
    expect(rects.get("2")).toMatchObject({ x: CATALOG_PAD + CATALOG_GUTTER, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP });
    expect(familyLabels(nodes, rects)).toHaveLength(1);
  });

  /** `count` families of two 400 × 120 variants each: too wide to share a row. */
  const families = (count: number) => [section("chips"), ...Array.from({ length: count }, (_, i) => [
    component(`f${i}-a`, `Family ${i}/A`, i * 2, { width: 400 }), component(`f${i}-b`, `Family ${i}/B`, i * 2 + 1, { width: 400 }),
  ]).flat()];

  it("keeps a catalog that isn't much taller than wide in one column", () => {
    // Five rows are 5 × 120 + 4 × 64 = 856 tall against a 240 + 840 = 1080 wide column: under the threshold.
    const rects = rectsOf(families(5));
    expect(new Set([...rects].filter(([id]) => id.endsWith("-a")).map(([, r]) => r.x))).toEqual(new Set([CATALOG_PAD + CATALOG_GUTTER]));
    expect(rects.get("chips")!.h - 2 * CATALOG_PAD).toBeLessThanOrEqual((rects.get("chips")!.w - 2 * CATALOG_PAD) * CATALOG_TALL);
  });

  it("stacks a tall catalog's families in balanced columns, in order, each with its own gutter", () => {
    const nodes = families(40), rects = rectsOf(nodes);
    const firsts = Array.from({ length: 40 }, (_, i) => rects.get(`f${i}-a`)!);
    const columns = [...new Set(firsts.map((r) => r.x))];
    expect(columns.length).toBeGreaterThan(1);
    // Order reads down each column, then across: x never decreases and y only resets at a new column.
    firsts.slice(1).forEach((r, i) => expect(r.x > firsts[i]!.x || r.x === firsts[i]!.x && r.y > firsts[i]!.y).toBe(true));
    // Columns are as tall as each other within one row, and the second starts past the first's widest row and gutter.
    const heights = columns.map((x) => firsts.filter((r) => r.x === x).length);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(columns[1]! - columns[0]!).toBe(2 * 400 + CATALOG_GAP + CATALOG_COLUMN_GAP + CATALOG_GUTTER);
    // The catalog is closer to square than one column would be.
    const box = rects.get("chips")!;
    expect(box.h / box.w).toBeLessThan(CATALOG_TALL);
    expect(firsts.every((a, i) => firsts.every((b, j) => i === j || !overlaps(a, b)))).toBe(true);
    // Each family is labelled once, in the gutter beside its first specimen, in its own column.
    const labels = familyLabels(nodes, rects);
    expect(labels).toHaveLength(40);
    expect(labels[heights[0]!]).toEqual({ family: `Family ${heights[0]}`, x: columns[1]! - CATALOG_GUTTER, y: CATALOG_PAD });
  });

  it("splits contiguous runs so the tallest is as short as possible", () => {
    expect(balancedStarts([100, 100, 100, 100], 2, 0)).toEqual([0, 2]);
    expect(balancedStarts([300, 100, 100, 100], 2, 0)).toEqual([0, 1]);
    expect(balancedStarts(Array(40).fill(120), 3, 64)).toEqual([0, 14, 27]);
    expect(balancedStarts([100, 100, 100, 300], 2, 10)).toEqual([0, 3]);
    expect(balancedStarts([50, 50, 50], 3, 0)).toEqual([0, 1, 2]);
  });

  it("sets out a family named Family/Row/Column as a ruled table with headers in place of specimen labels", () => {
    // Columns take their widest cell, rows their tallest; a cell is centred on its row, under a header row.
    const nodes = [section("chips"),
      component("pd", "Button/Primary/Default", 0, { width: 120, height: 40 }),
      component("pl", "Button/Primary/Large", 1, { width: 160, height: 56 }),
      component("gd", "Button/Ghost/Default", 2, { width: 100, height: 40 }),
      component("gl", "Button/Ghost/Large", 3, { width: 140, height: 56 }),
      component("tab", "Tab/Active", 4, { width: 900, height: 90 })];
    const rects = rectsOf(nodes);
    const left = CATALOG_PAD + CATALOG_GUTTER, second = left + 120 + 2 * TABLE_PAD_X;
    const row1 = CATALOG_PAD + TABLE_HEAD + TABLE_PAD_Y, row2 = row1 + 56 + 2 * TABLE_PAD_Y, bottom = row2 + 56 + TABLE_PAD_Y;
    expect(rects.get("pd")).toMatchObject({ x: left, y: row1 + 8 });
    expect(rects.get("pl")).toMatchObject({ x: second, y: row1 });
    expect(rects.get("gd")).toMatchObject({ x: left, y: row2 + 8 });
    expect(rects.get("gl")).toMatchObject({ x: second, y: row2 });
    expect(rects.get("tab")).toMatchObject({ x: left, y: bottom + CATALOG_ROW_GAP });
    const { labels, tables, cells } = catalogLabels(nodes, rects, catalogSectionIds(nodes));
    expect([...cells].sort()).toEqual(["gd", "gl", "pd", "pl"]);
    // The box starts at the gutter, which holds the row names, and its rules run through the gaps between cells.
    const right = second + 160 + TABLE_PAD_X;
    expect(tables).toEqual([{
      x: CATALOG_PAD, y: CATALOG_PAD, w: right - CATALOG_PAD, h: bottom - CATALOG_PAD, head: row1 - TABLE_PAD_Y,
      rows: [row1 + 56 + TABLE_PAD_Y], columns: [left - TABLE_PAD_X, left + 120 + TABLE_PAD_X],
    }]);
    for (const t of tables) for (const id of cells) expect(overlaps(rects.get(id)!, { ...t, h: t.head - t.y })).toBe(false);
    expect(labels).toEqual([
      { kind: "family", text: "Button", x: CATALOG_PAD, y: CATALOG_PAD, w: right - CATALOG_PAD },
      { kind: "column", text: "Default", x: left, y: CATALOG_PAD + TABLE_HEAD / 2, w: 120 + TABLE_PAD_X },
      { kind: "column", text: "Large", x: second, y: CATALOG_PAD + TABLE_HEAD / 2, w: 160 + TABLE_PAD_X },
      { kind: "row", text: "Primary", x: CATALOG_PAD + TABLE_PAD_X, y: row1 + 28, w: CATALOG_GUTTER - 3 * TABLE_PAD_X },
      { kind: "row", text: "Ghost", x: CATALOG_PAD + TABLE_PAD_X, y: row2 + 28, w: CATALOG_GUTTER - 3 * TABLE_PAD_X },
      { kind: "family", text: "Tab", x: CATALOG_PAD, y: bottom + CATALOG_ROW_GAP, w: CATALOG_GUTTER - 24 },
    ]);
  });

  it("shares a row between small families, naming each block after the first above itself", () => {
    const nodes = [section("chips"), component("check", "Checkbox/Default", 0, { description: "One choice per line." }),
      component("radio", "Radio/Default", 1), component("wide", "Card/Default", 2, { width: 900 })];
    const rects = rectsOf(nodes), left = CATALOG_PAD + CATALOG_GUTTER;
    expect(rects.get("check")).toMatchObject({ x: left, y: CATALOG_PAD });
    expect(rects.get("radio")).toMatchObject({ x: left + 200 + PACK_GAP, y: CATALOG_PAD });
    expect(rects.get("wide")).toMatchObject({ x: left, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP });
    expect(catalogLabels(nodes, rects, catalogSectionIds(nodes)).labels).toEqual([
      { kind: "family", text: "Checkbox", x: CATALOG_PAD, y: CATALOG_PAD, w: CATALOG_GUTTER - 24, note: "One choice per line.", noteBelow: true },
      { kind: "family", text: "Radio", x: left + 200 + PACK_GAP, y: CATALOG_PAD, w: 200 },
      { kind: "family", text: "Card", x: CATALOG_PAD, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP, w: CATALOG_GUTTER - 24 },
    ]);
  });

  it("stacks a family of specimens under a header of theme and value names", () => {
    const cw = 136 + 2 * CELL_PAD_X;
    const specimen: Specimen = { cellWidth: cw, axis: "size", columns: ["dark", "light"].flatMap((theme) => ["sm", "md"].map((value) => ({ theme, value }))) };
    const nodes = [section("chips"),
      component("p", "Button/Primary", 0, { width: 136, height: 64, specimen, description: "One primary per view." }),
      component("g", "Button/Ghost", 1, { width: 120, height: 56, specimen })];
    const rects = rectsOf(nodes), left = CATALOG_PAD + CATALOG_GUTTER, top = CATALOG_PAD + 2 * SPEC_TIER;
    // Each specimen spans its cells; rows sit flush, since specimens rule their own cells.
    expect(rects.get("p")).toEqual({ x: left, y: top, w: 4 * cw, h: 64 });
    expect(rects.get("g")).toEqual({ x: left, y: top + 64, w: 4 * cw, h: 56 });
    const { labels, tables, cells } = catalogLabels(nodes, rects, catalogSectionIds(nodes));
    expect([...cells]).toEqual(["p", "g"]);
    expect(tables).toEqual([{
      x: CATALOG_PAD, y: CATALOG_PAD, w: CATALOG_GUTTER + 4 * cw, h: 2 * SPEC_TIER + 120, head: top,
      rows: [CATALOG_PAD + SPEC_TIER, top + 64], columns: [left],
      headColumns: [{ x: left + cw, top: CATALOG_PAD + SPEC_TIER }, { x: left + 2 * cw, top: CATALOG_PAD }, { x: left + 3 * cw, top: CATALOG_PAD + SPEC_TIER }],
    }]);
    expect(labels.filter((l) => l.kind !== "column")).toEqual([
      { kind: "family", text: "Button", x: CATALOG_PAD, y: CATALOG_PAD, w: CATALOG_GUTTER + 4 * cw, note: "One primary per view." },
      { kind: "group", text: "Dark", x: left + TABLE_PAD_X, y: CATALOG_PAD + SPEC_TIER / 2, w: 2 * cw - TABLE_PAD_X },
      { kind: "group", text: "Light", x: left + 2 * cw + TABLE_PAD_X, y: CATALOG_PAD + SPEC_TIER / 2, w: 2 * cw - TABLE_PAD_X },
      { kind: "row", text: "Primary", x: CATALOG_PAD + TABLE_PAD_X, y: top + 32, w: CATALOG_GUTTER - 3 * TABLE_PAD_X },
      { kind: "row", text: "Ghost", x: CATALOG_PAD + TABLE_PAD_X, y: top + 64 + 28, w: CATALOG_GUTTER - 3 * TABLE_PAD_X },
    ]);
    expect(labels.filter((l) => l.kind === "column").map((l) => [l.text, l.x, l.y])).toEqual(
      ["sm", "md", "sm", "md"].map((text, k) => [text, left + k * cw + TABLE_PAD_X, CATALOG_PAD + SPEC_TIER * 1.5]));
  });

  it("keeps a family a row when any variant lacks a column or two variants share a cell", () => {
    const mixed = [section("chips"), component("a", "Button/Primary/Default", 0), component("b", "Button/Ghost", 1)];
    expect(catalogLabels(mixed, rectsOf(mixed), catalogSectionIds(mixed)).cells.size).toBe(0);
    expect(rectsOf(mixed).get("b")).toMatchObject({ x: CATALOG_PAD + CATALOG_GUTTER + 200 + CATALOG_GAP, y: CATALOG_PAD });
    const shared = [section("chips"), component("a", "Button/Primary/Default", 0), component("b", "Button / Primary / Default", 1)];
    expect(catalogLabels(shared, rectsOf(shared), catalogSectionIds(shared)).cells.size).toBe(0);
    expect(overlaps(rectsOf(shared).get("a")!, rectsOf(shared).get("b")!)).toBe(false);
  });

  it("drops the gutter when no component names a family, and keeps screen spacing once a frame joins", () => {
    const loose = [section("chips"), component("card", "Card", 0), component("toast", "Toast", 1)];
    expect(rectsOf(loose).get("toast")).toMatchObject({ x: CATALOG_PAD + 200 + CATALOG_GAP, y: CATALOG_PAD });
    const mixed = [...loose, node("screen", { parentId: "chips", order: 2 })];
    expect(catalogSectionIds(mixed).size).toBe(0);
    expect(rectsOf(mixed).get("card")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD });
  });
});

describe("automatic sections", () => {
  it("wraps after four screens and positions the next row below the tallest measured screen", () => {
    const nodes = [section("flow"), ...Array.from({ length: 5 }, (_, i) => node(`screen-${i}`, { parentId: "flow", width: 1440, height: null, order: i, measuredHeight: i === 2 ? 2000 : 800 }))];
    let rects = rectsOf(nodes);
    expect(rects.get("screen-3")!.y).toBe(SECTION_PAD);
    expect(rects.get("screen-4")!.x).toBe(SECTION_PAD);
    expect(rects.get("screen-4")!.y).toBe(SECTION_PAD + 2000 + AUTO_ROW_GAP);
    nodes[3]!.measuredHeight = 3000;
    rects = rectsOf(nodes);
    expect(rects.get("screen-4")!.y).toBe(SECTION_PAD + 3000 + AUTO_ROW_GAP);
    expect(rects.get("flow")!.h).toBe(SECTION_PAD * 2 + 3000 + AUTO_ROW_GAP + 800);
  });

  it("wraps a flow only at the width budget, so a phone flow keeps reading left to right", () => {
    const wide = [section("flow"), ...Array.from({ length: 3 }, (_, i) => node(`${i}`, { parentId: "flow", width: 3000, order: i }))];
    expect(rectsOf(wide).get("2")!.y).toBe(SECTION_PAD + 600 + AUTO_ROW_GAP);
    const mobile = [section("flow"), ...Array.from({ length: 14 }, (_, i) => node(`${i}`, { parentId: "flow", width: 390, order: i }))];
    const rects = rectsOf(mobile);
    // Thirteen 390px screens fit in the row width; the fourteenth starts the next row.
    expect(13 * 390 + 12 * AUTO_GAP).toBeLessThanOrEqual(AUTO_ROW_WIDTH);
    expect(rects.get("12")).toMatchObject({ x: SECTION_PAD + 12 * (390 + AUTO_GAP), y: SECTION_PAD });
    expect(rects.get("13")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD + 600 + AUTO_ROW_GAP });
  });

  it("keeps other automatic sections at four per row", () => {
    const board = [section("board"), ...Array.from({ length: 5 }, (_, i) => node(`${i}`, { parentId: "board", kind: "image", width: 390, order: i }))];
    expect(rectsOf(board).get("4")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD + 600 + AUTO_ROW_GAP });
  });

  it("tiles nested groups and root sections, and moves only what sits below a sheet that grows", () => {
    const nodes = [section("tokens", { order: 0 }), node("token-sheet", { parentId: "tokens", kind: "tokens", height: null, measuredHeight: 1400 }),
      section("components", { order: 1 }), section("buttons", { parentId: "components", order: 2 }), node("button", { parentId: "buttons", kind: "component", height: 80 }),
      section("inputs", { parentId: "components", order: 3 }), node("input", { parentId: "inputs", kind: "component", height: 120 }),
      section("sheets", { order: 2 }), node("sheet", { parentId: "sheets", kind: "tokens" })];
    const measure = (sheet: number) => layoutRects(nodes, (n) => layoutHeight(n, new Map([["token-sheet", sheet]])));
    const rects = measure(2400);
    const tokens = rects.get("tokens")!, components = rects.get("components")!, buttons = rects.get("buttons")!, inputs = rects.get("inputs")!;
    expect(tokens).toMatchObject({ x: 0, y: 0 });
    expect(components).toMatchObject({ x: 0, y: tokens.h + SECTION_GAP });
    expect(inputs).toMatchObject({ x: buttons.x + buttons.w + AUTO_GAP, y: buttons.y });
    expect(rects.get("button")!.y).toBe(buttons.y + CATALOG_PAD);
    const sheets = rects.get("sheets")!;
    expect(sheets).toMatchObject({ x: Math.max(tokens.w, components.w) + SECTION_GAP, y: 0 });
    const taller = measure(6000);
    expect(taller.get("components")).toMatchObject({ x: components.x, y: components.y + 3600 });
    expect(taller.get("sheets")).toEqual(sheets);
  });

  it("tiles ten nested groups into four columns, filled top to bottom", () => {
    const nodes = [section("components"), ...Array.from({ length: 10 }, (_, i) => group(`g${i}`, "components", i, [{ width: 1000 }])).flat()];
    const rects = rectsOf(nodes);
    expect(sectionColumns(10)).toBe(4);
    const { w, h } = catalogSize(1000);
    const slots = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [3, 0], [3, 1]];
    slots.forEach(([column, row], i) => {
      expect(rects.get(`g${i}`)).toMatchObject({ x: SECTION_PAD + column! * (w + AUTO_GAP), y: SECTION_PAD + row! * (h + AUTO_ROW_GAP), w, h });
    });
    expect(rects.get("components")).toMatchObject({ w: 4 * w + 3 * AUTO_GAP + SECTION_PAD * 2, h: 3 * h + 2 * AUTO_ROW_GAP + SECTION_PAD * 2 });
  });

  it("uses fewer columns past the tile width, but lets a narrow section sit beside a wide one", () => {
    expect(tileSections([{ w: 5000, h: 100 }, { w: 5000, h: 100 }, { w: 5000, h: 100 }], 80).offsets).toEqual([{ x: 0, y: 0 }, { x: 0, y: 180 }, { x: 0, y: 360 }]);
    expect(tileSections([{ w: 7000, h: 900 }, { w: 1200, h: 300 }], 80)).toEqual({ offsets: [{ x: 0, y: 0 }, { x: 7080, y: 0 }], w: 8280, h: 900 });
  });

  /** A flow of `screens` auto-height desktop screens, each measured 1440 × `height`. */
  const flow = (id: string, parentId: string | null, order: number, screens: number, height = 900) =>
    group(id, parentId, order, Array.from({ length: screens }, () => ({ kind: "frame" as const, width: 1440, height: null, measuredHeight: height })));

  it("keeps a few wide flows one per row", () => {
    const nodes = [section("page"), ...[0, 1, 2].flatMap((i) => flow(`f${i}`, "page", i, 4))];
    const rects = rectsOf(nodes);
    const [a, b, c] = ["f0", "f1", "f2"].map((id) => rects.get(id)!);
    expect(b).toMatchObject({ x: a!.x, y: a!.y + a!.h + AUTO_ROW_GAP });
    expect(c).toMatchObject({ x: a!.x, y: b!.y + b!.h + AUTO_ROW_GAP });
    expect(rects.get("page")!.w / rects.get("page")!.h).toBeGreaterThan(1);
  });

  it("tiles many narrower flows side by side, in order down each column, toward a landscape block", () => {
    const nodes = [section("page"), ...Array.from({ length: 6 }, (_, i) => flow(`f${i}`, "page", i, 3)).flat()];
    const rects = rectsOf(nodes);
    const f = Array.from({ length: 6 }, (_, i) => rects.get(`f${i}`)!);
    for (const i of [1, 2, 4, 5]) expect(f[i]).toMatchObject({ x: f[i - 1]!.x, y: f[i - 1]!.y + f[i - 1]!.h + AUTO_ROW_GAP });
    expect(f[3]).toMatchObject({ x: f[0]!.x + f[0]!.w + AUTO_GAP, y: f[0]!.y });
    const page = rects.get("page")!;
    expect(page.w / page.h).toBeGreaterThan(1);
    expect(page.w / page.h).toBeLessThan(FLOW_TILE_ASPECT * 2);
  });

  it("balances flow columns by height and keeps chosen columns when asked to", () => {
    const sizes = [{ w: 4000, h: 6000 }, { w: 4000, h: 1000 }, { w: 4000, h: 1000 }, { w: 4000, h: 1000 }, { w: 4000, h: 1000 }];
    const tiled = tileFlows(sizes, 80, 120);
    // The tall flow gets a column to itself rather than an even three-and-two split.
    expect(tiled.starts).toEqual([0, 1]);
    expect(tileFlows(sizes.map((s) => ({ ...s, h: s.h * 3 })), 80, 120, tiled.starts).starts).toEqual([0, 1]);
    expect(tileFlows([{ w: 400, h: 900 }], 80, 120)).toEqual({ offsets: [{ x: 0, y: 0 }], w: 400, h: 900, starts: [0] });
  });

  it("tiles consecutive flows and catalogs as one run", () => {
    const nodes = [section("page"), ...flow("onboarding", "page", 0, 2), ...group("chips", "page", 1), ...flow("checkout", "page", 2, 1)];
    const rects = rectsOf(nodes);
    const sizes = ["onboarding", "chips", "checkout"].map((id) => rects.get(id)!);
    const block = tileFlows(sizes, AUTO_GAP, AUTO_ROW_GAP);
    ["onboarding", "chips", "checkout"].forEach((id, i) =>
      expect(rects.get(id)).toMatchObject({ x: SECTION_PAD + block.offsets[i]!.x, y: SECTION_PAD + block.offsets[i]!.y }));
  });

  it("starts frames and nested groups on separate rows", () => {
    const nodes = [section("flow"), node("a", { parentId: "flow", order: 0 }), node("b", { parentId: "flow", order: 1 }),
      ...group("g1", "flow", 2, [{ width: 400 }]), ...group("g2", "flow", 3, [{ width: 400 }]), node("c", { parentId: "flow", order: 4 })];
    const rects = rectsOf(nodes);
    const { w, h } = catalogSize(400);
    expect(rects.get("b")).toMatchObject({ x: SECTION_PAD + 400 + AUTO_GAP, y: SECTION_PAD });
    expect(rects.get("g1")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD + 600 + AUTO_ROW_GAP });
    expect(rects.get("g2")).toMatchObject({ x: SECTION_PAD + w + AUTO_GAP, y: SECTION_PAD + 600 + AUTO_ROW_GAP });
    expect(rects.get("c")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD + 600 + AUTO_ROW_GAP + h + AUTO_ROW_GAP });
  });

  it("keeps every section in its column and place when measured heights change", () => {
    const groups = Array.from({ length: 12 }, (_, i) => group(`g${i}`, "components", i, [{ width: 600 + i * 50, height: null, measuredHeight: 400 }]));
    const roots = Array.from({ length: 5 }, (_, i) => group(`root${i}`, null, i, [{ height: null, measuredHeight: 400 }]));
    const nodes = [section("components", { order: -1 }), ...groups.flat(), ...roots.flat()];
    const sections = nodes.filter((n) => n.kind === "section");
    const layout = (seed: number) => {
      const live = new Map(nodes.filter((n) => n.kind === "component").map((n, i) => [n.id, 200 + (i * seed) % 1700]));
      const rects = layoutRects(nodes, (n) => layoutHeight(n, live));
      return sections.map((s) => ({ x: rects.get(s.id)!.x, above: sections
        .filter((o) => o.parentId === s.parentId && rects.get(o.id)!.x === rects.get(s.id)!.x && rects.get(o.id)!.y < rects.get(s.id)!.y).map((o) => o.id) }));
    };
    const before = layout(1);
    for (const seed of [7, 113, 997]) expect(layout(seed)).toEqual(before);
  });

  it("keeps every flow in its column when a live view reports other heights", () => {
    const nodes = [section("page"), ...Array.from({ length: 9 }, (_, i) => flow(`f${i}`, "page", i, 2 + i % 3)).flat()];
    const screens = nodes.filter((n) => n.kind === "frame");
    // Live screens in the first `tall` flows report full-page heights, which alone would rebalance the columns.
    const columnOf = (tall: number) => {
      const live = new Map(screens.map((n) => [n.id, Number(n.parentId!.slice(1)) < tall ? 6000 : 300]));
      const rects = layoutRects(nodes, (n) => layoutHeight(n, live));
      return Array.from({ length: 9 }, (_, i) => rects.get(`f${i}`)!.x);
    };
    const stored = rectsOf(nodes);
    const columns = Array.from({ length: 9 }, (_, i) => stored.get(`f${i}`)!.x);
    expect(new Set(columns).size).toBeGreaterThan(1);
    for (const tall of [1, 3, 6]) expect(columnOf(tall)).toEqual(columns);
  });

  it("has stable ordering when metadata arrives in another order, after an edit or deletion", () => {
    const nodes = [section("flow"), node("b", { parentId: "flow", order: 20 }), node("a", { parentId: "flow", order: 10 }), node("c", { parentId: "flow", order: 30 })];
    const before = rectsOf(nodes);
    expect(rectsOf([...nodes].reverse())).toEqual(before);
    expect(before.get("a")!.x).toBeLessThan(before.get("b")!.x);
    const after = rectsOf(nodes.filter((n) => n.id !== "a"));
    expect(after.get("b")!.x).toBe(SECTION_PAD);
    expect(after.get("c")!.x).toBe(SECTION_PAD + 400 + AUTO_GAP);
  });

  it("ignores stored positions, including those of loose nodes, which flow at the top of the page", () => {
    const nodes = [section("flow", { x: 100, y: 200, order: 2 }), section("nested", { parentId: "flow" }), node("screen", { parentId: "nested" }),
      node("loose-a", { x: -400, y: 700, order: 0 }), node("loose-b", { x: 9000, y: -50, order: 1 })];
    const before = rectsOf(nodes);
    expect(before.get("loose-a")).toMatchObject({ x: 0, y: 0 });
    expect(before.get("loose-b")).toMatchObject({ x: 400 + SECTION_GAP, y: 0 });
    expect(before.get("flow")).toMatchObject({ x: 0, y: 600 + SECTION_GAP });
    for (const n of nodes) { n.x += 700; n.y -= 100; }
    expect(rectsOf(nodes)).toEqual(before);
  });

  it("arranges each page from its own origin, and treats a node whose section is missing as top level", () => {
    const nodes = [section("one", { pageId: "a", x: 100, y: 200 }), section("two", { pageId: "b", x: 1000, y: 2000 }),
      node("orphan", { pageId: "b", parentId: "gone", order: 5 })];
    const rects = rectsOf(nodes);
    expect(rects.get("one")).toMatchObject({ x: 0, y: 0 });
    expect(rects.get("two")).toMatchObject({ x: 0, y: 0 });
    expect(rects.get("orphan")).toMatchObject({ y: 280 + SECTION_GAP });
  });

  it("lays out 5000 variable-height screens with no overlap between rows or groups", () => {
    const nodes: CanvasNode[] = [];
    for (let group = 0; group < 100; group++) {
      nodes.push(section(`flow-${group}`, { order: group }));
      for (let i = 0; i < 50; i++) nodes.push(node(`${group}-${i}`, { parentId: `flow-${group}`, order: i, height: null, measuredHeight: 500 + i * 37 }));
    }
    const rects = rectsOf(nodes);
    expect(rects.size).toBe(5100);
    const flows = Array.from({ length: 100 }, (_, group) => rects.get(`flow-${group}`)!);
    expect(flows.some((a, i) => flows.some((b, j) => i !== j && overlaps(a, b)))).toBe(false);
    for (let group = 0; group < 100; group++) {
      if (group) {
        // Reading order: below the previous group in its column, or at the top of the next column.
        const before = flows[group - 1]!, current = flows[group]!;
        if (current.x === before.x) expect(current.y).toBe(before.y + before.h + SECTION_GAP);
        else expect(current).toMatchObject({ x: Math.max(...flows.filter((r) => r.x === before.x).map((r) => r.x + r.w)) + SECTION_GAP, y: 0 });
      }
      // Screens fill a row left to right until the width budget, then the next row starts below the tallest one.
      let row: Rect[] = [];
      for (let i = 0; i < 50; i++) {
        const r = rects.get(`${group}-${i}`)!, left = flows[group]!.x + SECTION_PAD;
        if (i && r.x === left) {
          expect(r.y).toBe(Math.max(...row.map((p) => p.y + p.h)) + AUTO_ROW_GAP);
          row = [];
        } else if (i) {
          expect(r).toMatchObject({ x: row.at(-1)!.x + row.at(-1)!.w + AUTO_GAP, y: row[0]!.y });
        }
        row.push(r);
        expect(r.x + r.w - left).toBeLessThanOrEqual(AUTO_ROW_WIDTH);
      }
    }
  });
});


