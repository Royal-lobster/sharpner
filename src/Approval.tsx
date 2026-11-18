import { useState } from "react";
import { IconCircleCheck, IconCircleDashedCheck } from "@tabler/icons-react";
import { approvable, approvalState } from "../shared/approvals";
import type { CanvasNode } from "../shared/types";
import { timeAgo } from "./api";
import { askConfirm } from "./dialog";
import type { Room } from "./room";
import { toast } from "./toast";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const date = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When the selected design was created and last changed. Designs from before Sharpner recorded dates show nothing. */
export function DesignDates({ node }: { node: CanvasNode }) {
  if (node.changedAt == null) return null;
  const full = [node.createdAt != null && `Created ${date(node.createdAt)}`, `Last changed ${date(node.changedAt)}`].filter(Boolean).join(" · ");
  return (
    <Tooltip><TooltipTrigger asChild>
      <time className="selection-dates" dateTime={new Date(node.changedAt).toISOString()} tabIndex={0}>Changed {timeAgo(node.changedAt)}</time>
    </TooltipTrigger><TooltipContent side="top">{full}</TooltipContent></Tooltip>
  );
}

/** Approve the selected frame, approve it again after a change, or withdraw its approval. */
export function ApprovalButton({ room, node }: { room: Room; node: CanvasNode }) {
  const [busy, setBusy] = useState(false);
  if (!approvable(node)) return null;
  const approval = room.approvals.get(node.id);
  const state = approvalState(node, approval);
  const set = async (approved: boolean) => {
    if (!approved && !await askConfirm({ title: "Withdraw approval?", message: `${node.name} will show as not approved. Its approval date is removed.`, confirm: "Withdraw" })) return;
    setBusy(true);
    try { await room.approve(node.id, approved); }
    catch (error) { toast((error as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  const by = approval && `${approval.approvedBy.name} approved this ${date(approval.approvedAt)}`;
  const disabled = busy || room.status !== "open";
  if (state === "approved") return (
    <Tooltip><TooltipTrigger asChild>
      <Button size="lg" variant="secondary" className="selection-action" aria-pressed disabled={disabled} onClick={() => set(false)}>
        <IconCircleCheck aria-hidden />Approved<span className="selection-approval-date">{timeAgo(approval!.approvedAt)}</span>
      </Button>
    </TooltipTrigger><TooltipContent side="top">{by}. Click to withdraw.</TooltipContent></Tooltip>
  );
  return (
    <Tooltip><TooltipTrigger asChild>
      <Button size="lg" variant={state === "changed" ? "default" : "ghost"} className="selection-action" disabled={disabled} onClick={() => set(true)}>
        <IconCircleDashedCheck aria-hidden />{state === "changed" ? "Approve again" : "Approve"}
      </Button>
    </TooltipTrigger><TooltipContent side="top">{state === "changed"
      ? `Changed since approval. ${by}; it changed ${date(node.changedAt!)}.`
      : "Sign off on this design. Members and agents see who approved it and when."}</TooltipContent></Tooltip>
  );
}
