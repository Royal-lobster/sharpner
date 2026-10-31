import { describe, expect, it } from "vitest";
import { fitLabel, LABEL_GAP, LABEL_LINE, labelBaseline } from "./canvas-labels";

const context = (font: string, charWidth: number) => ({
  font,
  measureText: (text: string) => ({ width: text.length * charWidth, fontBoundingBoxAscent: 11.6, fontBoundingBoxDescent: 2.9 }),
}) as unknown as CanvasRenderingContext2D;

describe("canvas labels", () => {
  it("keeps names that fit and cuts the rest with an ellipsis inside the width", () => {
    const ctx = context("12px test-fit", 6);
    expect(fitLabel(ctx, "Checkout", 48)).toBe("Checkout");
    expect(fitLabel(ctx, "Checkout / Payment", 60)).toBe("Checkout…");
    expect(fitLabel(ctx, "Checkout / Payment", 4)).toBe("");
  });

  it("places the baseline where a CSS line box of the same height puts it", () => {
    const baseline = labelBaseline(context("12px test-baseline", 6));
    // Half the leading plus the descent above the line box's bottom, which sits LABEL_GAP above the node.
    expect(baseline).toBeCloseTo(LABEL_GAP + (LABEL_LINE - 11.6 - 2.9) / 2 + 2.9);
  });
});
