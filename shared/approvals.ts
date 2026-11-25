import type { Actor, CanvasNode } from "./types";

/** Only frames are designs a member signs off. */
export const approvable = (node: Pick<CanvasNode, "kind">) => node.kind === "frame";

/**
 * - approved: signed off, and nothing it renders changed since.
 * - changed: signed off, then its source, size or design system changed. The approval stays on record.
 * - null: never approved, or the approval was withdrawn.
 */
export type ApprovalState = "approved" | "changed" | null;

export function approvalState(node: Pick<CanvasNode, "changedAt">, approval: { approvedAt: number } | undefined): ApprovalState {
  if (!approval) return null;
  return node.changedAt != null && node.changedAt > approval.approvedAt ? "changed" : "approved";
}

/** A member's sign-off on a frame. An agent's approval keeps the member's id and is marked as the agent's. */
export type Approval = { nodeId: string; approvedAt: number; approvedBy: Actor };
