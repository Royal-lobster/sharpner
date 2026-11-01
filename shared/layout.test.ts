import { describe, expect, it } from "vitest";
import { AUTO_GAP, AUTO_ROW_GAP, AUTO_ROW_WIDTH, balancedStarts, CATALOG_COLUMN_GAP, CATALOG_GAP, CATALOG_GUTTER, CATALOG_TALL, CATALOG_PAD, CATALOG_ROW_GAP, catalogFamilyLabels, catalogSectionIds, dropOrders, isManaged, layoutHeight, layoutRects, pageArrangement, type Rect, SECTION_GAP, SECTION_PAD, sectionColumns, tileSections } from "./layout";
import type { CanvasNode } from "./types";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const section = (id: string, patch: Partial<CanvasNode> = {}) => node(id, { kind: "section", layout: "auto", width: 0, height: null, ...patch });
const rectsOf = (nodes: CanvasNode[]) => layoutRects(nodes, layoutHeight);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** A group section holding the given nodes: by default one component, which makes it a catalog. */
const group = (id: string, parentId: string | null, order: number, members: Partial<CanvasNode>[] = [{}]) => [
  section(id, { parentId, order }),
  ...members.map((patch, i) => node(`${id}-${i}`, { parentId: id, order: i, kind: "component", ...patch })),
];
/** A catalog group holding one `width` × 600 component. */
const catalogSize = (width: number) => ({ w: width + CATALOG_PAD * 2, h: 600 + CATALOG_PAD * 2 });

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
    expect(catalogFamilyLabels(nodes, rects, catalogSectionIds(nodes))).toEqual([
      { family: "Chip", x: CATALOG_PAD, y: CATALOG_PAD },
      { family: "Tab", x: CATALOG_PAD, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP },
    ]);
  });

  it("wraps a long family at the row width without repeating its name", () => {
    const nodes = [section("chips"), ...Array.from({ length: 4 }, (_, i) => component(`${i}`, `Card/${i}`, i, { width: 600 }))];
    const rects = rectsOf(nodes);
    expect(rects.get("2")).toMatchObject({ x: CATALOG_PAD + CATALOG_GUTTER, y: CATALOG_PAD + 120 + CATALOG_ROW_GAP });
    expect(catalogFamilyLabels(nodes, rects, catalogSectionIds(nodes))).toHaveLength(1);
  });

  /** `count` families of two 200 × 120 variants each. */
  const families = (count: number) => [section("chips"), ...Array.from({ length: count }, (_, i) => [
    component(`f${i}-a`, `Family ${i}/A`, i * 2), component(`f${i}-b`, `Family ${i}/B`, i * 2 + 1),
  ]).flat()];

  it("keeps a catalog that isn't much taller than wide in one column", () => {
    // Five rows are 5 × 120 + 4 × 64 = 856 tall against a 160 + 440 = 600 wide column: under the threshold.
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
    expect(columns[1]! - columns[0]!).toBe(2 * 200 + CATALOG_GAP + CATALOG_COLUMN_GAP + CATALOG_GUTTER);
    // The catalog is closer to square than one column would be.
    const box = rects.get("chips")!;
    expect(box.h / box.w).toBeLessThan(CATALOG_TALL);
    expect(firsts.every((a, i) => firsts.every((b, j) => i === j || !overlaps(a, b)))).toBe(true);
    // Each family is labelled once, in the gutter beside its first specimen, in its own column.
    const labels = catalogFamilyLabels(nodes, rects, catalogSectionIds(nodes));
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

  it("tiles nested groups and root sections, keeps a flow on its own row, and moves it after live measurements", () => {
    const nodes = [section("tokens", { order: 0 }), node("token-sheet", { parentId: "tokens", kind: "tokens", height: null, measuredHeight: 1400 }),
      section("components", { order: 1 }), section("buttons", { parentId: "components", order: 2 }), node("button", { parentId: "buttons", kind: "component", height: 80 }),
      section("inputs", { parentId: "components", order: 3, layout: "free" }), node("input", { parentId: "inputs", kind: "component", x: 1000, y: 2500, height: 120 }),
      section("screens", { order: 4 }), node("screen", { parentId: "screens" })];
    const measure = (sheet: number) => layoutRects(nodes, (n) => layoutHeight(n, new Map([["token-sheet", sheet]])));
    const rects = measure(2400);
    const tokens = rects.get("tokens")!, components = rects.get("components")!, buttons = rects.get("buttons")!, inputs = rects.get("inputs")!;
    expect(components).toMatchObject({ x: tokens.x + tokens.w + SECTION_GAP, y: tokens.y });
    expect(inputs).toMatchObject({ x: buttons.x + buttons.w + AUTO_GAP, y: buttons.y });
    expect(rects.get("input")!.y).toBe(inputs.y + SECTION_PAD);
    expect(rects.get("button")!.y).toBe(buttons.y + CATALOG_PAD);
    // A section of screens reads left to right, so it takes its own row below the tiled sections.
    const screens = rects.get("screens")!;
    expect(screens).toMatchObject({ x: tokens.x, y: tokens.y + Math.max(tokens.h, components.h) + SECTION_GAP });
    const taller = measure(6000);
    expect(taller.get("components")).toEqual(components);
    expect(taller.get("screens")).toMatchObject({ x: screens.x, y: screens.y + 3600 });
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

  it("keeps each flow on its own row and tiles the sections between flows", () => {
    const desktop = Array.from({ length: 2 }, () => ({ kind: "frame" as const, width: 1440 }));
    const nodes = [section("page"), ...group("onboarding", "page", 0, desktop), ...group("chips", "page", 1), ...group("tabs", "page", 2),
      ...group("checkout", "page", 3, [{ kind: "frame", width: 390 }])];
    const rects = rectsOf(nodes);
    const onboarding = rects.get("onboarding")!, chips = rects.get("chips")!, tabs = rects.get("tabs")!, checkout = rects.get("checkout")!;
    expect(chips).toMatchObject({ x: onboarding.x, y: onboarding.y + onboarding.h + AUTO_ROW_GAP });
    expect(tabs).toMatchObject({ x: chips.x + chips.w + AUTO_GAP, y: chips.y });
    // Even a narrow flow that would fit beside the catalogs starts its own row.
    expect(checkout).toMatchObject({ x: onboarding.x, y: chips.y + chips.h + AUTO_ROW_GAP });
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

  it("keeps automatic sections in one column on a page with manual content, and says which content does it", () => {
    const tiled = [section("tokens", { order: 0 }), section("components", { order: 1 }), node("button", { parentId: "components", kind: "component" })];
    expect(rectsOf(tiled).get("components")).toMatchObject({ x: 480 + SECTION_GAP, y: 0 });
    expect(pageArrangement(tiled)).toEqual({ arrangement: "tiled" });
    for (const manual of [section("placed", { layout: "free", x: 640, y: 0 }), node("loose", { x: 640, y: 0 })]) {
      expect(rectsOf([...tiled, manual]).get("components")).toMatchObject({ x: 0, y: 280 + SECTION_GAP });
      expect(pageArrangement([...tiled, manual])).toEqual({ arrangement: "stacked", stackedBy: [manual] });
    }
    expect(pageArrangement([node("loose")])).toEqual({ arrangement: "manual" });
    expect(pageArrangement([])).toEqual({ arrangement: "tiled" });
  });

  it("preserves legacy/free arrangements and every loose node", () => {
    const nodes = [section("legacy", { layout: undefined, x: -900, y: -900 }), node("a", { parentId: "legacy", x: 100, y: 200 }),
      node("b", { parentId: "legacy", x: 1400, y: 300 }), node("loose", { x: -400, y: 700 }), section("auto", { x: 3000 })];
    const rects = rectsOf(nodes);
    expect(rects.get("a")).toMatchObject({ x: 100, y: 200 });
    expect(rects.get("b")).toMatchObject({ x: 1400, y: 300 });
    expect(rects.get("legacy")).toEqual({ x: 100 - SECTION_PAD, y: 200 - SECTION_PAD, w: 1700 + SECTION_PAD * 2, h: 700 + SECTION_PAD * 2 });
    expect(rects.get("loose")).toMatchObject({ x: -400, y: 700 });
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

  it("moves an automatic section and its descendants together", () => {
    const nodes = [section("flow", { x: 100, y: 200 }), section("nested", { parentId: "flow" }), node("screen", { parentId: "nested" })];
    const before = rectsOf(nodes);
    nodes[0]!.x += 700; nodes[0]!.y -= 100;
    const after = rectsOf(nodes);
    for (const n of nodes) expect(after.get(n.id)).toEqual({ ...before.get(n.id)!, x: before.get(n.id)!.x + 700, y: before.get(n.id)!.y - 100 });
  });

  it("uses independent section stacks for each page", () => {
    const nodes = [section("one", { pageId: "a", x: 100, y: 200 }), section("two", { pageId: "b", x: 1000, y: 2000 })];
    expect(rectsOf(nodes).get("two")).toMatchObject({ x: 1000, y: 2000 });
  });

  it("leaves a dragged child floating while preserving its slot and drop target", () => {
    const nodes = [section("flow"), node("a", { parentId: "flow", x: 8000, y: 8000 }), node("b", { parentId: "flow" })];
    const rects = layoutRects(nodes, layoutHeight, new Set(["a"]));
    expect(rects.get("a")).toMatchObject({ x: 8000, y: 8000 });
    expect(rects.get("b")).toMatchObject({ x: SECTION_PAD + 400 + AUTO_GAP, y: SECTION_PAD });
    expect(rects.get("flow")!.w).toBe(800 + AUTO_GAP + SECTION_PAD * 2);
  });

  it("keeps root section slots steady while one section is being dragged", () => {
    const nodes = [section("a", { order: 1, x: -1000, y: -1000 }), section("b", { order: 2, x: 100, y: 200 })];
    const rects = layoutRects(nodes, layoutHeight, new Set(["a"]));
    expect(rects.get("a")).toMatchObject({ x: -1000, y: -1000 });
    expect(rects.get("b")).toMatchObject({ x: 100 + 480 + SECTION_GAP, y: 200 });
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
        // Reading order: beside the previous group in its row, or below the whole previous row.
        const before = flows[group - 1]!, current = flows[group]!;
        if (current.y === before.y) expect(current.x).toBe(before.x + before.w + SECTION_GAP);
        else expect(current.y).toBe(Math.max(...flows.filter((r) => r.y === before.y).map((r) => r.y + r.h)) + SECTION_GAP);
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

describe("drag ordering", () => {
  it("treats descendants of a free group inside automatic layout as having derived coordinates", () => {
    const frames = [section("auto"), section("free", { parentId: "auto", layout: "free" }), node("nested", { parentId: "free" }), node("loose")];
    const nodes = new Map(frames.map((f) => [f.id, f]));
    expect(isManaged(nodes.get("nested")!, nodes)).toBe(true);
    expect(isManaged(nodes.get("loose")!, nodes)).toBe(false);
  });

  it("inserts before, between and after siblings without changing their orders", () => {
    const nodes = [section("flow"), node("a", { parentId: "flow", order: 10 }), node("b", { parentId: "flow", order: 20 }), node("moving", { order: 30 })];
    const rects = rectsOf(nodes);
    const a = rects.get("a")!, b = rects.get("b")!, y = a.y + a.h / 2;
    const first = dropOrders(nodes, rects, ["moving"], "flow", "page", { x: a.x - 1, y }).get("moving")!;
    const middle = dropOrders(nodes, rects, ["moving"], "flow", "page", { x: (a.x + a.w + b.x) / 2, y }).get("moving")!;
    const last = dropOrders(nodes, rects, ["moving"], "flow", "page", { x: b.x + b.w + 1, y }).get("moving")!;
    expect(first).toBeLessThan(10); expect(middle).toBeGreaterThan(10); expect(middle).toBeLessThan(20); expect(last).toBeGreaterThan(20);
  });

  it("preserves the relative order of a moved block and supports empty groups", () => {
    const nodes = [section("flow"), node("a", { order: 10 }), node("b", { order: 20 })];
    const orders = dropOrders(nodes, rectsOf(nodes), ["b", "a"], "flow", "page", { x: 0, y: 0 });
    expect(orders.get("a")).toBeLessThan(orders.get("b")!);
  });

  it("reorders page sections without shifting the stack origin", () => {
    const nodes = [section("a", { order: 10 }), section("b", { order: 20 }), section("c", { order: 30 })];
    const before = rectsOf(nodes);
    const orders = dropOrders(nodes, before, ["c"], null, "page", { x: 0, y: -100 });
    nodes[2]!.order = orders.get("c");
    const after = rectsOf(nodes);
    expect(after.get("c")).toMatchObject({ x: 0, y: 0 });
    expect(after.get("a")).toMatchObject({ x: 0, y: 280 + SECTION_GAP });
  });

  it("inserts between sections stacked in a tiled column, and after the last column", () => {
    const nodes = [section("a", { order: 10 }), section("b", { order: 20 }), section("c", { order: 30 }), section("moving", { order: 40 })];
    const rects = rectsOf(nodes), a = rects.get("a")!, b = rects.get("b")!, c = rects.get("c")!;
    expect(b.x).toBe(a.x); expect(c.y).toBe(a.y);
    const between = dropOrders(nodes, rects, ["moving"], null, "page", { x: a.x + a.w / 2, y: (a.y + a.h + b.y) / 2 }).get("moving")!;
    expect(between).toBeGreaterThan(10); expect(between).toBeLessThan(20);
    expect(dropOrders(nodes, rects, ["moving"], null, "page", { x: c.x + c.w / 2, y: c.y + c.h + 10 }).get("moving")).toBeGreaterThan(30);
  });

  it("rebalances a group when a narrow order gap has exhausted numeric precision", () => {
    const nodes = [section("flow"), node("a", { parentId: "flow", order: 1 }), node("b", { parentId: "flow", order: 1 + Number.EPSILON }), node("moving", { order: 30 })];
    const rects = rectsOf(nodes), a = rects.get("a")!, b = rects.get("b")!;
    const orders = dropOrders(nodes, rects, ["moving"], "flow", "page", { x: (a.x + a.w + b.x) / 2, y: a.y + a.h / 2 });
    expect(orders.size).toBe(3);
    expect(orders.get("a")).toBeLessThan(orders.get("moving")!);
    expect(orders.get("moving")).toBeLessThan(orders.get("b")!);
  });
});
