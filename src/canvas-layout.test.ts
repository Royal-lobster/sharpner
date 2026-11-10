import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../shared/types";
import { anchoredToHidden, withoutComponents } from "./canvas-layout";

const node = (id: string, kind: CanvasNode["kind"], parentId: string | null = null): CanvasNode => ({
  id, pageId: "page", parentId, kind, name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1,
});
const ids = (nodes: CanvasNode[]) => nodes.map((n) => n.id);

describe("withoutComponents", () => {
  it("returns the same array when a page has no components, so cached geometry stays valid", () => {
    const page = [node("flow", "section"), node("home", "frame", "flow")];
    expect(withoutComponents(page)).toBe(page);
  });

  it("drops components and keeps screens, images and token sheets", () => {
    const page = [node("flow", "section"), node("home", "frame", "flow"), node("Button", "component", "flow"),
      node("logo", "image"), node("tokens", "tokens"), node("Card", "component")];
    expect(ids(withoutComponents(page))).toEqual(["flow", "home", "logo", "tokens"]);
  });

  it("drops sections that held only components, at any depth", () => {
    const page = [node("parts", "section"), node("inner", "section", "parts"), node("Button", "component", "inner"),
      node("Badge", "component", "parts"), node("flow", "section"), node("home", "frame", "flow")];
    expect(ids(withoutComponents(page))).toEqual(["flow", "home"]);
  });

  it("keeps a section with a screen beside its components, and sections that were already empty", () => {
    const page = [node("mixed", "section"), node("Button", "component", "mixed"), node("home", "frame", "mixed"),
      node("placeholder", "section"), node("Card", "component")];
    expect(ids(withoutComponents(page))).toEqual(["mixed", "home", "placeholder"]);
  });
});

describe("anchoredToHidden", () => {
  const room = { nodes: new Map([["Button", node("Button", "component")], ["home", node("home", "frame")]]) };
  const rects = new Map([["home", { x: 0, y: 0, w: 1, h: 1 }]]);

  it("is true only for a comment on a node that exists but is not laid out", () => {
    expect(anchoredToHidden({ pageId: "page", nodeId: "Button", x: 0, y: 0 }, rects, room)).toBe(true);
    expect(anchoredToHidden({ pageId: "page", nodeId: "home", x: 0, y: 0 }, rects, room)).toBe(false);
    expect(anchoredToHidden({ pageId: "page", nodeId: null, x: 0, y: 0 }, rects, room)).toBe(false);
  });

  it("leaves a comment on a deleted node where it was", () => {
    expect(anchoredToHidden({ pageId: "page", nodeId: "gone", x: 0, y: 0 }, rects, room)).toBe(false);
  });
});
