import { useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconCheck, IconMessageCircle, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import type { CommentAnchor, CommentDetail, CommentThread } from "../shared/types";
import { MAX_COMMENT_BODY } from "../shared/comments";
import type { Room } from "./room";
import { timeAgo } from "./api";
import { Avatar } from "./Avatar";
import { toast } from "./toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CommentsPanel({ room, open, activeId, draft, onSelect, onNew, onClose, onCancelDraft }: {
  room: Room; open: boolean; activeId: string | null; draft: CommentAnchor | null;
  onSelect: (thread: CommentThread | null) => void; onNew: () => void; onClose: () => void; onCancelDraft: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [detail, setDetail] = useState<CommentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const panel = useRef<HTMLElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const threads = [...room.comments.values()];
  const active = activeId ? room.comments.get(activeId) : undefined;
  const openCount = threads.filter((t) => t.resolvedAt === null).length;
  const online = room.status === "open";
  const draftKey = draft ? `new:${draft.pageId}:${draft.nodeId}:${draft.x}:${draft.y}` : "new";
  const composer = (key: string) => ({ body: drafts[key] ?? "", onBodyChange: (body: string) => setDrafts((previous) => {
    const next = { ...previous };
    if (body) next[key] = body; else delete next[key];
    return next;
  }) });

  // Only the mobile sheet reserves canvas space, and only as much as it actually uses.
  useEffect(() => {
    const element = panel.current, stage = element?.parentElement;
    if (!element || !stage) return;
    const observer = new ResizeObserver(() => stage.style.setProperty("--comments-panel-height", `${element.getBoundingClientRect().height}px`));
    observer.observe(element);
    return () => { observer.disconnect(); stage.style.removeProperty("--comments-panel-height"); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const target = panel.current?.querySelector<HTMLElement>("textarea,button");
    target?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open || !active) { if (!active) setDetail(null); return; }
    const controller = new AbortController();
    setError(null);
    room.getComment(active.id, controller.signal).then((next) => {
      if (!controller.signal.aborted) setDetail((current) => current?.id === next.id && current.revision > next.revision ? current : next);
    }).catch((e: Error) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [room, open, active?.id, active?.revision, retry]);

  useEffect(() => {
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [detail?.id, detail?.messages.length]);

  const resolve = async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const next = await room.resolveComment(active.id, active.resolvedAt === null);
      setDetail((current) => current?.id === next.id && current.revision > next.revision ? current : next);
    }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  const label = (anchor: CommentAnchor) => {
    const node = anchor.nodeId ? room.nodes.get(anchor.nodeId) : undefined;
    return [room.pages.find((p) => p.id === anchor.pageId)?.name, node?.name ?? "Canvas"].filter(Boolean).join(" · ");
  };
  const currentDetail = detail?.id === active?.id ? detail : null;

  return <aside ref={panel} id="comments-panel" hidden={!open} className="comments-panel canvas-glass" aria-label="Comments" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } }} onPointerDown={(e) => e.stopPropagation()}>
    <header className="comments-heading">
      <h2>Comments <span className="comment-count">{openCount}</span></h2>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Add a comment" title="Add a comment (C)" onClick={onNew} disabled={!online}><IconPlus aria-hidden /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={onClose}><IconX aria-hidden /></Button>
      </div>
    </header>
    {draft && !active ? <div className="comment-draft">
      <p className="comment-location">{label(draft)}</p>
      <CommentComposer key={draftKey} {...composer(draftKey)} label="Your comment" placeholder="What could be better here?" submit="Post comment" disabled={!online}
        onSubmit={async (body) => { const thread = await room.createComment(draft, body); onCancelDraft(); onSelect(thread); }} />
      <Button variant="ghost" size="sm" onClick={() => { composer(draftKey).onBodyChange(""); onCancelDraft(); }}>Discard draft</Button>
      <p className="comment-hint">Your agent can read this feedback when you ask it to address comments.</p>
    </div> : active ? <>
      <div className="comment-thread-toolbar">
        <Button variant="ghost" size="sm" onClick={() => onSelect(null)}><IconArrowLeft aria-hidden />All comments</Button>
        <Button variant={active.resolvedAt ? "secondary" : "ghost"} size="sm" disabled={busy || !online} onClick={() => void resolve()}>
          {active.resolvedAt ? <IconRefresh aria-hidden /> : <IconCheck aria-hidden />}{active.resolvedAt ? "Reopen" : "Resolve"}
        </Button>
      </div>
      <p className="comment-location">#{active.number} · {label(active.anchor)}</p>
      <div className="comment-messages" ref={messages} aria-busy={!currentDetail && !error}>
        {error ? <div className="comment-load-error" role="alert"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRetry((v) => v + 1)}>Try again</Button></div>
          : !currentDetail ? <p className="comment-hint" role="status">Loading conversation…</p>
          : currentDetail.messages.map((message) => <article className="comment-message" key={message.id}>
            <div className="comment-author">
              <Avatar name={message.author.name} id={message.author.id} src={message.author.avatar} agent={message.author.agent} />
              <div><strong>{message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{timeAgo(message.createdAt)}</time></div>
            </div>
            <p>{message.body}</p>
          </article>)}
        {active.resolvedAt !== null && <p className="comment-resolved"><IconCheck aria-hidden />Resolved by {active.resolvedBy?.name ?? "a member"}</p>}
      </div>
      <div className="comment-reply">
        <CommentComposer key={active.id} {...composer(`reply:${active.id}`)} label="Reply to comment" placeholder="Reply…" submit="Reply" disabled={!online}
          onSubmit={async (body) => {
            const next = await room.replyComment(active.id, body);
            setDetail((current) => current?.id === next.id && current.revision > next.revision ? current : next);
          }} />
      </div>
    </> : <>
      <div className="comment-filters" aria-label="Filter comments">
        <Button variant={filter === "open" ? "secondary" : "ghost"} size="sm" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Open <span>{openCount}</span></Button>
        <Button variant={filter === "resolved" ? "secondary" : "ghost"} size="sm" aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")}>Resolved <span>{threads.length - openCount}</span></Button>
      </div>
      <div className="comment-list">
        {threads.filter((t) => (t.resolvedAt === null) === (filter === "open")).sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number).map((thread) => <button className="comment-card" key={thread.id} onClick={() => onSelect(thread)}>
          <span className="comment-card-top"><strong>{thread.firstMessage.author.name}</strong><span>#{thread.number}</span></span>
          <span className="comment-card-body">{thread.firstMessage.body}</span>
          <span className="comment-card-meta">{label(thread.anchor)}</span>
          <span className="comment-card-meta">{timeAgo(thread.updatedAt)}{thread.messageCount > 1 && ` · ${thread.messageCount - 1} ${thread.messageCount === 2 ? "reply" : "replies"}`}</span>
        </button>)}
        {!threads.some((t) => (t.resolvedAt === null) === (filter === "open")) && <div className="comments-empty">
          <IconMessageCircle aria-hidden /><p>{filter === "open" ? "No open comments" : "No resolved comments"}</p>
          <span>{filter === "open" ? "Pin feedback anywhere on the canvas. Ask your agent to address it when you’re ready." : "Resolved conversations will stay here."}</span>
          {filter === "open" && <Button variant="secondary" size="sm" disabled={!online} onClick={onNew}>Add a comment</Button>}
        </div>}
      </div>
    </>}
    {!online && <p className="comment-offline" role="status">Reconnecting… Your draft is kept here.</p>}
  </aside>;
}

function CommentComposer({ body, onBodyChange, label, placeholder, submit, disabled, onSubmit }: {
  body: string; onBodyChange: (body: string) => void; label: string; placeholder: string; submit: string; disabled: boolean; onSubmit: (body: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!body.trim() || busy || disabled) return;
    setBusy(true);
    try { await onSubmit(body.trim()); onBodyChange(""); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  return <form className="comment-composer" onSubmit={(e) => { e.preventDefault(); void post(); }}>
    <Textarea aria-label={label} placeholder={placeholder} value={body} maxLength={MAX_COMMENT_BODY} disabled={busy} autoFocus
      onChange={(e) => onBodyChange(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void post(); } }} />
    <div className="comment-composer-actions"><span>{body.length > MAX_COMMENT_BODY - 500 ? `${body.length}/${MAX_COMMENT_BODY}` : "⌘ / Ctrl + Enter to post"}</span>
      <Button type="submit" size="sm" disabled={disabled || busy || !body.trim()}>{busy ? "Posting…" : submit}</Button>
    </div>
  </form>;
}
