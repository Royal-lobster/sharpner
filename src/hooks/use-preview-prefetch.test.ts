import { describe, expect, it } from "vitest";
import { previewPrefetchAllowed } from "./use-preview-prefetch";

describe("optional preview prefetch", () => {
  it("uses a bounded queue when connection hints are unavailable", () => {
    expect(previewPrefetchAllowed()).toBe(true);
  });

  it.each([
    { saveData: true, effectiveType: "4g", downlink: 10 },
    { effectiveType: "slow-2g" }, { effectiveType: "2g" }, { effectiveType: "3g" },
    { effectiveType: "4g", downlink: 0.5 },
  ])("respects data saving and limited connections: %j", connection => {
    expect(previewPrefetchAllowed(connection)).toBe(false);
  });

  it("resumes optional upgrades when the connection improves", () => {
    const connection = { effectiveType: "3g", downlink: 0.5 };
    expect(previewPrefetchAllowed(connection)).toBe(false);
    Object.assign(connection, { effectiveType: "4g", downlink: 10 });
    expect(previewPrefetchAllowed(connection)).toBe(true);
  });
});
