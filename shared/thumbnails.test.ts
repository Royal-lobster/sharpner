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

describe("matching theme previews", () => {
  it("swaps URLs and dimensions immediately in both directions at the same content revision", () => {
    const dark = selectThumbnail(node, "dark");
    expect(dark).toMatchObject({ rev: 2, thumbHi: "dark-hi", measuredHeight: 900 });
    expect(previewCurrent(dark)).toBe(true);
    expect(selectThumbnail(dark, "light")).toEqual(node);
    expect(selectThumbnail(dark, null).thumbHi).toBe("authored-hi");
  });

  it("keeps a dimmed fallback when a theme or content pair is missing", () => {
    const missing = selectThumbnail(node, "uwu");
    expect(missing.thumbHi).toBe("light-hi");
    expect(previewCurrent(missing)).toBe(false);
    expect(previewCurrent(selectThumbnail({ ...node, rev: 3 }, "dark"))).toBe(false);
    expect(selectThumbnail(missing, "light").thumbRev).toBe(2);
  });

  it("honors frame and component overrides, and keeps token comparisons theme independent", () => {
    expect(selectThumbnail({ ...node, theme: "light" }, "dark").thumbHi).toBe("light-hi");
    expect(selectThumbnail({ ...node, kind: "component", theme: "dark" }, "light").thumbHi).toBe("dark-hi");
    expect(selectThumbnail({ ...node, kind: "tokens" }, "dark").thumbHi).toBe("authored-hi");
    const legacy = { ...node, thumbnails: undefined };
    expect(selectThumbnail(legacy, "dark")).toBe(legacy);
  });
});
