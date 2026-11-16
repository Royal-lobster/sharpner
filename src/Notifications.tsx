import { useState } from "react";
import { IconAt, IconBell } from "@tabler/icons-react";
import type { MentionNotification } from "../shared/types";
import { timeAgo } from "./api";
import { Avatar } from "./Avatar";
import { navigate } from "./router";
import { markNotificationsRead, useNotifications } from "./notification-store";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";

export const threadPath = (n: Pick<MentionNotification, "fileId" | "pageId" | "threadId">) =>
  `/f/${encodeURIComponent(n.fileId)}?page=${encodeURIComponent(n.pageId)}&comment=${encodeURIComponent(n.threadId)}`;

/** The bell: mentions of the signed-in member, newest first, each saying who tagged them, where and why. */
export function NotificationBell({ className, size = "icon", side = "bottom", onOpenChange }: {
  className?: string; size?: "icon" | "icon-lg" | "lg"; side?: "top" | "bottom"; onOpenChange?: (open: boolean) => void;
}) {
  const { notifications, unread, loaded } = useNotifications();
  const [open, setOpen] = useState(false);
  const change = (next: boolean) => { setOpen(next); onOpenChange?.(next); };
  const go = (n: MentionNotification) => {
    change(false);
    void markNotificationsRead({ ids: [n.id] });
    navigate(threadPath(n));
  };
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return <Popover open={open} onOpenChange={change}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size={size} className={cn("notification-bell", className)} aria-label={label} title={label}>
        <IconBell aria-hidden />
        {unread > 0 && <span className="notification-count" aria-hidden>{unread > 99 ? "99+" : unread}</span>}
      </Button>
    </PopoverTrigger>
    <PopoverContent side={side} align="end" sideOffset={12} collisionPadding={16} aria-label="Notifications"
      className="notification-popover w-[360px] max-w-[calc(100vw-32px)] gap-0 p-0" onKeyDown={(e) => e.stopPropagation()}>
      <div className="dock-panel-head">
        <h2 className="dock-panel-title">Mentions{unread > 0 && <span className="dock-panel-count" aria-label={`${unread} unread`}>{unread}</span>}</h2>
        {unread > 0 && <Button variant="ghost" size="sm" onClick={() => void markNotificationsRead({})}>Mark all read</Button>}
      </div>
      <div className="notification-list">
        {!loaded ? <p className="comment-hint notification-empty" role="status">Loading…</p>
          : notifications.length === 0 ? <div className="comments-empty notification-empty">
            <IconAt aria-hidden /><p>No mentions yet</p>
            <span>When someone tags you with @ in a comment, it shows up here with what they said.</span>
          </div>
          : notifications.map((n) => <button key={n.id} className={cn("notification-item", n.readAt === null && "unread")} onClick={() => go(n)}>
            <Avatar id={n.actor.id} name={n.actor.name} src={n.actor.avatar} agent={n.actor.agent} />
            <span className="notification-text">
              <span className="notification-title"><strong>{n.actor.name}</strong> mentioned you in <strong>{n.fileName}</strong></span>
              <span className="notification-quote">{n.excerpt}</span>
              <span className="notification-meta">#{n.threadNumber} · {n.location} · {timeAgo(n.createdAt)}</span>
            </span>
            {n.readAt === null && <span className="notification-dot" aria-label="Unread" role="img" />}
          </button>)}
      </div>
    </PopoverContent>
  </Popover>;
}
