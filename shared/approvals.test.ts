import { describe, expect, it } from "vitest";
import { approvable, approvalState } from "./approvals";

describe("approval state", () => {
  it("is unapproved without an approval", () => {
    expect(approvalState({ changedAt: 10 }, undefined)).toBeNull();
  });

  it("stays approved until what the frame renders changes after the sign-off", () => {
    expect(approvalState({ changedAt: 10 }, { approvedAt: 20 })).toBe("approved");
    expect(approvalState({ changedAt: 20 }, { approvedAt: 20 })).toBe("approved");
    expect(approvalState({ changedAt: 21 }, { approvedAt: 20 })).toBe("changed");
  });

  it("treats a design from before Sharpner recorded dates as unchanged", () => {
    expect(approvalState({ changedAt: null }, { approvedAt: 20 })).toBe("approved");
    expect(approvalState({}, { approvedAt: 20 })).toBe("approved");
  });

  it("approves frames only", () => {
    expect(approvable({ kind: "frame" })).toBe(true);
    for (const kind of ["image", "component", "section", "tokens"] as const) expect(approvable({ kind })).toBe(false);
  });
});
