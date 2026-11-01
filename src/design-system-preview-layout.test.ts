import { expect, it } from "vitest";
import { fitPreview } from "./design-system-preview";

it("fits wide controls to phone width without clipping their height", () => {
  const fitted = fitPreview(324, 900, 800);
  expect(fitted.scale * 900).toBe(324);
  expect(fitted.height).toBe(288);
});

it("keeps tall primitives complete and avoids enlarging small controls", () => {
  expect(fitPreview(800, 640, 900)).toEqual({ scale: 1, height: 900 });
  expect(fitPreview(800, 200, 160)).toEqual({ scale: 1, height: 160 });
});
