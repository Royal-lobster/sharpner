import { describe, expect, it } from "vitest";
import { AUTO_GAP, CATALOG_GAP, CATALOG_GUTTER, CATALOG_PAD, CATALOG_ROW_GAP, catalogFamilyLabels, catalogSectionIds, dropOrders, isManaged, layoutHeight, layoutRects, SECTION_GAP, SECTION_PAD } from "./layout";
import type { CanvasNode } from "./types";

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const section = (id: string, patch: Partial<CanvasNode> = {}) => node(id, { kind: "section", layout: "auto", width: 0, height: null, ...patch });
const rectsOf = (nodes: CanvasNode[]) => layoutRects(nodes, layoutHeight);

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
    expect(rects.get("screen-4")!.y).toBe(SECTION_PAD + 2000 + AUTO_GAP);
    nodes[3]!.measuredHeight = 3000;
    rects = rectsOf(nodes);
    expect(rects.get("screen-4")!.y).toBe(SECTION_PAD + 3000 + AUTO_GAP);
    expect(rects.get("flow")!.h).toBe(SECTION_PAD * 2 + 3000 + AUTO_GAP + 800);
  });

  it("wraps wide screens before the width budget and small screens at four columns", () => {
    const wide = [section("flow"), ...Array.from({ length: 3 }, (_, i) => node(`${i}`, { parentId: "flow", width: 3000, order: i }))];
    expect(rectsOf(wide).get("2")!.y).toBe(SECTION_PAD + 600 + AUTO_GAP);
    const mobile = wide.map((n) => n.kind === "section" ? n : { ...n, width: 390 });
    mobile.push(node("3", { parentId: "flow", width: 390, order: 3 }), node("4", { parentId: "flow", width: 390, order: 4 }));
    expect(rectsOf(mobile).get("4")!.y).toBe(SECTION_PAD + 600 + AUTO_GAP);
  });

  it("stacks nested groups and root sections after live measurements, including a free nested group", () => {
    const nodes = [section("tokens", { order: 0 }), node("token-sheet", { parentId: "tokens", height: null, measuredHeight: 1400 }),
      section("components", { order: 1 }), section("buttons", { parentId: "components", order: 2 }), node("button", { parentId: "buttons", height: 80 }),
      section("inputs", { parentId: "components", order: 3, layout: "free" }), node("input", { parentId: "inputs", x: 1000, y: 2500, height: 120 })];
    const live = new Map([["token-sheet", 2400]]);
    const rects = layoutRects(nodes, (n) => layoutHeight(n, live));
    const tokens = rects.get("tokens")!, components = rects.get("components")!, buttons = rects.get("buttons")!, inputs = rects.get("inputs")!;
    expect(components.y).toBe(tokens.y + tokens.h + SECTION_GAP);
    expect(inputs.y).toBe(buttons.y + buttons.h + AUTO_GAP);
    expect(rects.get("input")!.y).toBe(inputs.y + SECTION_PAD);
    expect(rects.get("button")!.y).toBe(buttons.y + SECTION_PAD);
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
    expect(rects.get("b")).toMatchObject({ x: 100, y: 200 + 280 + SECTION_GAP });
  });

  it("lays out 5000 variable-height screens with no overlap between rows or groups", () => {
    const nodes: CanvasNode[] = [];
    for (let group = 0; group < 100; group++) {
      nodes.push(section(`flow-${group}`, { order: group }));
      for (let i = 0; i < 50; i++) nodes.push(node(`${group}-${i}`, { parentId: `flow-${group}`, order: i, height: null, measuredHeight: 500 + i * 37 }));
    }
    const rects = rectsOf(nodes);
    expect(rects.size).toBe(5100);
    for (let group = 0; group < 100; group++) {
      if (group) {
        const before = rects.get(`flow-${group - 1}`)!, current = rects.get(`flow-${group}`)!;
        expect(current.y).toBe(before.y + before.h + SECTION_GAP);
      }
      for (let i = 4; i < 50; i += 4) {
        const rowBottom = Math.max(...Array.from({ length: 4 }, (_, j) => {
          const r = rects.get(`${group}-${i - 4 + j}`)!; return r.y + r.h;
        }));
        expect(rects.get(`${group}-${i}`)!.y).toBe(rowBottom + AUTO_GAP);
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

  it("reorders page sections vertically without shifting the stack origin", () => {
    const nodes = [section("a", { order: 10 }), section("b", { order: 20 }), section("c", { order: 30 })];
    const before = rectsOf(nodes);
    const orders = dropOrders(nodes, before, ["c"], null, "page", { x: 0, y: -100 });
    nodes[2]!.order = orders.get("c");
    const after = rectsOf(nodes);
    expect(after.get("c")!.y).toBe(0);
    expect(after.get("a")!.y).toBeGreaterThan(after.get("c")!.y);
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
