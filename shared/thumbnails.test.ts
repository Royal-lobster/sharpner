import { describe, expect, it } from "vitest";
import { selectThumbnail } from "./thumbnails";
import { previewCurrent, type CanvasNode } from "./types";

const node: CanvasNode = {
  id: "screen", pageId: "page", parentId: null, kind: "frame", name: "Screen", x: 0, y: 0,
  width: 400, height: null, measuredHeight: 600, src: null, rev: 2,
  thumbLo: "light-lo", thumbHi: "light-hi", thumbRev: 2, thumbTheme: "light",
  thumbnails: {
    light: { rev: 2, lo: "light-lo", hi: "light-hi", measuredHeight: 600 },
    dark: { rev: 2, lo: "dark-lo", hi: "dark-hi", measuredHeight: 900 },
    "": { rev: 2, lo: "authored-lo", hi: "authored-hi", measuredHeight: 700 },
  },
};

describe("thumbnail selection", () => {
  it("selects the current pair and keeps a dimmed fallback while a new revision renders", () => {
    expect(selectThumbnail(node)).toMatchObject({ rev: 2, thumbHi: "authored-hi", measuredHeight: 700, thumbTheme: "" });
    expect(previewCurrent(selectThumbnail(node))).toBe(true);
    const outdated = selectThumbnail({ ...node, rev: 3 });
    expect(outdated.thumbHi).toBe("light-hi");
    expect(previewCurrent(outdated)).toBe(false);
    const legacy = { ...node, thumbnails: undefined };
    expect(selectThumbnail(legacy)).toBe(legacy);
  });
});
