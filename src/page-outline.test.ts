import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../shared/types";
import { pageOutline, type OutlineItem } from "./page-outline";

const node = (id: string, kind: CanvasNode["kind"], parentId: string | null = null, order?: number): CanvasNode => ({
  id, pageId: "page", parentId, kind, name: id, x: 0, y: 0, order,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1,
});
/** A compact view of the tree: sections as "name(count)[open]" with their children, designs by name ("*" when selected). */
const shape = (items: OutlineItem[]): unknown[] => items.map((item) => item.kind === "design"
  ? item.node.id + (item.selected ? "*" : "")
  : { [`${item.node.id}(${item.count})${item.open ? "" : "-"}`]: shape(item.children) });

const page = [
  node("checkout", "section", null, 1), node("cart", "frame", "checkout", 1), node("pay", "frame", "checkout", 2),
  node("done", "frame", "checkout", 3), node("onboarding", "section", null, 2), node("welcome", "frame", "onboarding", 1),
  node("edge", "section", null, 3), node("errors", "section", "edge", 1), node("offline", "frame", "errors", 1), node("empty", "frame", "edge", 2),
  node("logo", "image", null, 4),
];

describe("pageOutline", () => {
  it("opens the sections holding the selection, at any depth, and marks the selected design", () => {
    expect(shape(pageOutline(page, { selection: ["offline"], toggled: new Map() }))).toEqual([
      { "checkout(3)-": [] }, { "onboarding(1)-": [] }, { "edge(2)": [{ "errors(1)": ["offline*"] }, "empty"] }, "logo",
    ]);
  });

  it("opens the first section when nothing is selected, so the popover always lists screens", () => {
    expect(shape(pageOutline(page, { selection: [], toggled: new Map() }))[0]).toEqual({ "checkout(3)": ["cart", "pay", "done"] });
  });

  it("lets the viewer open and close sections regardless of the selection", () => {
    const outline = pageOutline(page, { selection: ["pay"], toggled: new Map([["checkout", false], ["onboarding", true]]) });
    expect(shape(outline).slice(0, 2)).toEqual([{ "checkout(3)-": [] }, { "onboarding(1)": ["welcome"] }]);
  });

  it("follows canvas order, not storage order, and puts designs whose section is missing at the top level", () => {
    const shuffled = [node("b", "frame", "s", 2), node("s", "section", null, 1), node("a", "frame", "s", 1), node("orphan", "frame", "gone", 0)];
    expect(shape(pageOutline(shuffled, { selection: [], toggled: new Map() }))).toEqual(["orphan", { "s(2)": ["a", "b"] }]);
  });

  it("is empty for an empty page", () => {
    expect(pageOutline([], { selection: [], toggled: new Map() })).toEqual([]);
  });
});
