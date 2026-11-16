import { useEffect, useId, useRef, useState } from "react";
import { IconArrowLeft, IconCheck, IconMessageCircle, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import type { Actor, CommentAnchor, CommentDetail, CommentThread, MentionableMember } from "../shared/types";
import { MAX_COMMENT_BODY } from "../shared/comments";
import { insertMention, mentionQuery, mentionSegments, mentionsIn, mentionSuggestions } from "../shared/mentions";
import { markNotificationsRead } from "./notification-store";
import type { Room } from "./room";
import { timeAgo } from "./api";
import { Avatar } from "./Avatar";
import { toast } from "./toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CommentsPanel({ room, userId, open, activeId, draft, onSelect, onNew, onClose, onCancelDraft }: {
  room: Room; userId: string; open: boolean; activeId: string | null; draft: CommentAnchor | null;
  onSelect: (thread: CommentThread | null) => void; onNew: () => void; onClose: () => void; onCancelDraft: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [detail, setDetail] = useState<CommentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<MentionableMember[]>([]);
  const panel = useRef<HTMLElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const threads = [...room.comments.values()];
  const active = activeId ? room.comments.get(activeId) : undefined;
  const openCount = threads.filter((t) => t.resolvedAt === null).length;
  const online = room.status === "open";
  // One new comment is drafted at a time. Placing it again moves it, so its text stays with it.
  const draftKey = "new";
  const composer = (key: string) => ({ body: drafts[key] ?? "", members, onBodyChange: (body: string) => setDrafts((previous) => {
    const next = { ...previous };
    if (body) next[key] = body; else delete next[key];
    return next;
  }) });

  // On wide screens the panel is a column beside the canvas, which narrows to make room. The phone sheet floats
  // over the canvas instead, which reserves only as much space as the sheet actually uses (see .comments-open .canvas).
  useEffect(() => {
    const element = panel.current, editor = element?.parentElement;
    if (!element || !editor) return;
    const observer = new ResizeObserver(() => editor.style.setProperty("--comments-panel-height", `${element.getBoundingClientRect().height}px`));
    observer.observe(element);
    return () => { observer.disconnect(); editor.style.removeProperty("--comments-panel-height"); };
  }, []);

  // Suggestions for @ tags. Without them a comment still posts; it just tags no one.
  useEffect(() => {
    if (!open || members.length) return;
    let current = true;
    room.members().then((list) => { if (current) setMembers(list); }).catch(() => {});
    return () => { current = false; };
  }, [room, open, members.length]);

  // Reading a thread answers the mentions that pointed here.
  useEffect(() => { if (open && active) void markNotificationsRead({ threadId: active.id }); }, [open, active?.id]);

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

  const resolve = async (thread: CommentThread, fromList = false) => {
    if (busy || !online) return;
    setBusy(true);
    try {
      const next = await room.resolveComment(thread.id, thread.resolvedAt === null);
      if (activeId === thread.id) setDetail((current) => current?.id === next.id && current.revision > next.revision ? current : next);
      setAnnouncement(next.resolvedAt ? `Comment #${next.number} resolved` : `Comment #${next.number} reopened`);
      if (fromList) requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(".comment-card-open, .comment-filters button[aria-pressed=true]")?.focus({ preventScroll: true }));
    }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  const label = (anchor: CommentAnchor) => {
    const node = anchor.nodeId ? room.nodes.get(anchor.nodeId) : undefined;
    return [room.pages.find((p) => p.id === anchor.pageId)?.name, node?.name ?? "Canvas"].filter(Boolean).join(" · ");
  };
  const currentDetail = detail?.id === active?.id ? detail : null;

  return <aside ref={panel} id="comments-panel" hidden={!open} className="comments-panel panel" aria-label="Comments" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } }} onPointerDown={(e) => e.stopPropagation()}>
    <p className="sr-only" role="status">{announcement}</p>
    <header className="comments-heading">
      <h2>Comments <span className="comment-count" aria-label={`${openCount} open`}>{openCount}</span></h2>
      <div className="flex gap-1 text-muted-foreground">
        <Button variant="ghost" size="icon-sm" aria-label="Add a comment" title="Add a comment (C)" onClick={onNew} disabled={!online}><IconPlus aria-hidden /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={onClose}><IconX aria-hidden /></Button>
      </div>
    </header>
    <div className="comments-rule" aria-hidden />
    {draft && !active ? <div className="comment-draft">
      <p className="comment-location">{label(draft)}</p>
      <CommentComposer key={draftKey} {...composer(draftKey)} label="Your comment" placeholder="What could be better here?" submit="Post comment" disabled={!online} suggestionsBelow
        onSubmit={async (body, mentions) => { const thread = await room.createComment(draft, body, mentions); onCancelDraft(); onSelect(thread); }} />
      <Button variant="ghost" size="sm" onClick={() => { composer(draftKey).onBodyChange(""); onCancelDraft(); }}>Discard draft</Button>
      <p className="comment-hint">Type @ to tag a teammate; they’ll be notified. Your agent can read this feedback when you ask it to address comments.</p>
    </div> : active ? <>
      <div className="comment-thread-toolbar">
        <Button variant="ghost" size="lg" onClick={() => onSelect(null)}><IconArrowLeft aria-hidden />All comments</Button>
        <Button variant="secondary" size="lg" disabled={busy || !online} onClick={() => void resolve(active)}>
          {active.resolvedAt ? <IconRefresh aria-hidden /> : <IconCheck aria-hidden />}{active.resolvedAt ? "Reopen" : "Resolve"}
        </Button>
      </div>
      <p className="comment-location">#{active.number} · {label(active.anchor)}</p>
      <div className="comment-messages" ref={messages} aria-busy={!currentDetail && !error}>
        {error ? <div className="comment-load-error" role="alert"><p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRetry((v) => v + 1)}>Try again</Button></div>
          : !currentDetail ? <p className="comment-hint" role="status">Loading conversation…</p>
          : currentDetail.messages.map((message) => <article className="comment-message" key={message.id}>
            <Avatar name={message.author.name} id={message.author.id} src={message.author.avatar} agent={message.author.agent} />
            <div className="comment-message-body">
              <div className="comment-author"><strong>{message.author.name}</strong><time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{timeAgo(message.createdAt)}</time></div>
              <p><MentionText body={message.body} mentions={message.mentions} userId={userId} /></p>
            </div>
          </article>)}
        {active.resolvedAt !== null && <p className="comment-resolved"><IconCheck aria-hidden />Resolved by {active.resolvedBy?.name ?? "a member"}</p>}
      </div>
      <div className="comment-reply">
        <CommentComposer key={active.id} {...composer(`reply:${active.id}`)} label="Reply to comment" placeholder="Reply…" submit="Reply" disabled={!online}
          onSubmit={async (body, mentions) => {
            const next = await room.replyComment(active.id, body, mentions);
            setDetail((current) => current?.id === next.id && current.revision > next.revision ? current : next);
          }} />
      </div>
    </> : <>
      <div className="comment-filters well" aria-label="Filter comments">
        <Button variant={filter === "open" ? "secondary" : "ghost"} size="sm" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Open <span>{openCount}</span></Button>
        <Button variant={filter === "resolved" ? "secondary" : "ghost"} size="sm" aria-pressed={filter === "resolved"} onClick={() => setFilter("resolved")}>Resolved <span>{threads.length - openCount}</span></Button>
      </div>
      <div className="comment-list">
        {threads.filter((t) => (t.resolvedAt === null) === (filter === "open")).sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number).map((thread) => <div className="comment-card" key={thread.id}>
          <button className="comment-card-open" onClick={() => onSelect(thread)}>
            <Avatar id={thread.firstMessage.author.id} name={thread.firstMessage.author.name} src={thread.firstMessage.author.avatar} agent={thread.firstMessage.author.agent} />
            <span className="comment-card-text">
              <span className="comment-card-top"><strong>{thread.firstMessage.author.name}</strong><span>#{thread.number}</span></span>
              <span className="comment-card-body"><MentionText body={thread.firstMessage.body} mentions={thread.firstMessage.mentions} userId={userId} /></span>
              <span className="comment-card-meta">{label(thread.anchor)} · {timeAgo(thread.updatedAt)}{thread.messageCount > 1 && ` · ${thread.messageCount - 1} ${thread.messageCount === 2 ? "reply" : "replies"}`}</span>
            </span>
          </button>
          <Button variant="ghost" size="icon-sm" className="comment-card-resolve" disabled={busy || !online}
            aria-label={`${thread.resolvedAt ? "Reopen" : "Resolve"} comment ${thread.number}`} title={thread.resolvedAt ? "Reopen comment" : "Resolve comment"}
            onClick={() => void resolve(thread, true)}>
            {thread.resolvedAt ? <IconRefresh aria-hidden /> : <IconCheck aria-hidden />}
          </Button>
        </div>)}
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

/** A message body with its tagged members highlighted; tags of the viewer stand out. */
function MentionText({ body, mentions, userId }: { body: string; mentions?: Actor[]; userId: string }) {
  return <>{mentionSegments(body, mentions).map((segment, i) => segment.mention
    ? <span key={i} className={`comment-mention${segment.mention.id === userId ? " self" : ""}`}>{segment.text}</span>
    : segment.text)}</>;
}

/**
 * Suggestions sit in the panel's flow, never floating, so no scrolling column or sheet can clip them: under the box
 * for a new comment, which starts at the top of the panel, and over it for a reply, which sits at the bottom.
 */
function CommentComposer({ body, members, onBodyChange, label, placeholder, submit, disabled, onSubmit, suggestionsBelow = false }: {
  body: string; members: MentionableMember[]; onBodyChange: (body: string) => void; label: string; placeholder: string; submit: string; disabled: boolean;
  onSubmit: (body: string, mentions: string[]) => Promise<void>; suggestionsBelow?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const typed = caret === null ? null : mentionQuery(body, caret);
  const suggestions = typed && typed.start !== dismissed ? mentionSuggestions(members, typed.query) : [];
  const choice = suggestions[Math.min(active, suggestions.length - 1)];

  const track = (element: HTMLTextAreaElement) => setCaret(element.selectionStart === element.selectionEnd ? element.selectionStart : null);
  const pick = (member: MentionableMember) => {
    if (!typed || caret === null) return;
    const next = insertMention(body, caret, typed.start, member.name);
    onBodyChange(next.text);
    setCaret(next.caret); setActive(0);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  const post = async () => {
    if (!body.trim() || busy || disabled) return;
    setBusy(true);
    try { await onSubmit(body.trim(), mentionsIn(body, members).map((m) => m.id)); onBodyChange(""); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  const list = suggestions.length > 0 && <ul id={listId} role="listbox" className="mention-suggestions floaty" aria-label="Tag a teammate">
      {suggestions.map((member) => <li key={member.id} id={`${listId}-${member.id}`} role="option" aria-selected={member === choice}
        className="mention-option" onPointerDown={(e) => { e.preventDefault(); pick(member); }} onPointerEnter={() => setActive(suggestions.indexOf(member))}>
        <Avatar id={member.id} name={member.name} src={member.avatar} />
        <span><strong>{member.name}</strong>{member.login && member.login !== member.name && <small>@{member.login}</small>}</span>
      </li>)}
    </ul>;
  return <form className="comment-composer" onSubmit={(e) => { e.preventDefault(); void post(); }}>
    {!suggestionsBelow && list}
    <Textarea ref={input} aria-label={label} placeholder={placeholder} value={body} maxLength={MAX_COMMENT_BODY} disabled={busy} autoFocus
      role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length ? listId : undefined}
      aria-activedescendant={choice ? `${listId}-${choice.id}` : undefined}
      onChange={(e) => { onBodyChange(e.target.value); track(e.target); setActive(0); }}
      onSelect={(e) => track(e.currentTarget)} onBlur={() => setCaret(null)}
      onKeyDown={(e) => {
        if (choice) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (Math.min(i, suggestions.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            return;
          }
          if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); pick(choice); return; }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(typed!.start); return; }
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void post(); }
      }} />
    {suggestionsBelow && list}
    <div className="comment-composer-actions"><span>{body.length > MAX_COMMENT_BODY - 500 ? `${body.length}/${MAX_COMMENT_BODY}` : "@ to tag · ⌘ / Ctrl + Enter to post"}</span>
      <Button type="submit" size="sm" disabled={disabled || busy || !body.trim()}>{busy ? "Posting…" : submit}</Button>
    </div>
  </form>;
}
