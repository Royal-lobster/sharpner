import { describe, expect, it } from "vitest";
import { imagePreviewFor } from "./image-preview";

describe("image preview ownership", () => {
  it("does not advertise a full-size original as a low-resolution preview", () => {
    expect(imagePreviewFor("/a/photo-4k.jpg")).toBeNull();
    expect(imagePreviewFor("/a/photo-4k.jpg", "/a/photo-4k.jpg")).toBeNull();
  });
  it("keeps a supplied preview and an existing preview when only geometry changes", () => {
    expect(imagePreviewFor("/a/original.jpg", "/a/small.webp")).toBe("/a/small.webp");
    expect(imagePreviewFor("/a/original.jpg", undefined, { src: "/a/original.jpg", thumbLo: "/a/small.webp" })).toBe("/a/small.webp");
  });
  it("discards a previous source's preview when the original is replaced", () => {
    expect(imagePreviewFor("/a/new.jpg", undefined, { src: "/a/old.jpg", thumbLo: "/a/old-small.webp" })).toBeNull();
    expect(imagePreviewFor("/a/new.jpg", "/a/new-small.webp", { src: "/a/old.jpg", thumbLo: "/a/old-small.webp" })).toBe("/a/new-small.webp");
  });
  it("recognizes legacy original aliases and empty previews as needing generation", () => {
    expect(imagePreviewFor("/a/original.jpg", undefined, { src: "/a/original.jpg", thumbLo: "/a/original.jpg" })).toBeNull();
    expect(imagePreviewFor("/a/original.jpg", "")).toBeNull();
  });
});
