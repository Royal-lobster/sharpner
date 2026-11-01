import { describe, expect, it } from "vitest";
import { thumbnailThemes } from "./thumbnail-policy";

const frame = { kind: "frame" as const };
const tokens = '[data-theme="dark"] {} [data-theme="uwu"] {} [data-theme="sepia"] {} [data-theme="contrast"] {}';
describe("thumbnail warming policy", () => {
  it("never warms unused or removed themes; active choices remain renderable", () => {
    expect(thumbnailThemes(frame, "light", [], tokens)).toEqual(["light"]);
    expect(thumbnailThemes(frame, "dark", ["light", "removed", ""], tokens)).toEqual(["dark", "light", ""]);
    expect(thumbnailThemes(frame, "custom", [], tokens)).toEqual(["custom"]);
  });
  it("bounds cache cardinality and avoids warming fixed specimens or frame overrides", () => {
    expect(thumbnailThemes(frame, "light", ["dark", "uwu", "sepia", "contrast", ""], tokens)).toEqual(["light", "dark", "uwu", "sepia"]);
    expect(thumbnailThemes({ ...frame, theme: "dark" }, "light", ["uwu"], tokens)).toEqual(["dark"]);
    expect(thumbnailThemes({kind:"tokens"}, "dark", ["light"], tokens)).toEqual([""]);
  });
});
