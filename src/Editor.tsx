import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { IconCheck as Check, IconChevronDown as ChevronDown, IconFileText as FileText, IconLayoutGrid, IconLink as Link2, IconPencil as Pencil, IconSparkles, IconComponents, IconKeyboard, IconMessageCircle, IconPlayerPlay } from "@tabler/icons-react";
import { useAuth, useClerk } from "@clerk/react";
import { api, HttpError, type FileInfo, type User } from "./api";
import { samePrincipal } from "../shared/session-principal";
import { Avatar } from "./Avatar";
import { CommentsPanel } from "./Comments";
import type { CommentAnchor, CommentThread, Page } from "../shared/types";
import { peopleInFile } from "./presence";
import { Canvas } from "./Canvas";
import { canInteract } from "./canvas-render-plan";
import { canvasLocationUrl, useCanvasLocation, type CanvasLocation } from "./canvas-location";
import { withoutComponents } from "./canvas-layout";
import { pageOutline, type OutlineItem } from "./page-outline";
import { Room } from "./room";
import { Link, navigate, useLocation } from "./router";
import { NotificationBell } from "./Notifications";
import { askConfirm, askText } from "./dialog";
import { ResponsiveDialog } from "./dialog-runtime";
import { Loading, Notice } from "./states";
import { toast } from "./toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDesktop, useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { claimFileStartup, type FileMeta } from "./file-startup";
import { Kbd } from "@/components/ui/kbd";
import { AvatarStack } from "@/components/ui/avatar-stack";

export { prepareFileStartup, cancelFileStartup } from "./file-startup";

type SharedMeta = { file: { id: string; name: string }; workspace: { name: string } };

const shareUrl = (token: string, view: CanvasLocation) => `${location.origin}${canvasLocationUrl(new URL(`/s/${token}`, location.origin), view)}`;

/** A file opened through a view link: no account, no editing, live updates. */
export function SharedEditor({ token }: { token: string }) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  useEffect(() => {
    let active: Room | null = null;
    const controller = new AbortController();
    api<SharedMeta>(`/shared/${token}`, { signal: controller.signal }).then((data) => {
      setMeta({
        user: { id: "link-viewer", login: "", name: "Viewer", avatar_url: null },
        file: { id: data.file.id, name: data.file.name, workspace_id: "", library_id: null },
        workspace: { id: "", clerkOrganizationId: "", name: data.workspace.name, role: "member" },
        files: [], shareToken: null,
      });
      active = new Room(data.file.id, token);
      setRoom(active);
    }).catch((e: Error) => { if (e.name !== "AbortError") setError(e.message); });
    return () => { controller.abort(); active?.close(); };
  }, [token]);
  if (error) return <Notice title="This link isn’t shared anymore" message="Ask someone in the workspace for a new link." action={<Button asChild size="lg"><a href="/">Open Sharpner</a></Button>} />;
  if (!room || !meta) return <EditorLoading label="Opening shared file…" />;
  return <EditorInner room={room} meta={meta} user={meta.user} readOnly onChange={() => {}} />;
}

export function Editor({ fileId }: { fileId: string }) {
  const { userId, sessionId, orgId } = useAuth();
  const clerk = useClerk();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setMeta(null); setRoom(null); setError(null);
    // Metadata and the socket each authorize access; neither needs to wait for the other.
    let active: Room | null = null;
    let unsubscribe: (() => void) | undefined;
    const identity = userId && sessionId ? { clerkUserId: userId, sessionId, organizationId: orgId ?? null } : null;
    const startup = identity ? claimFileStartup(fileId, identity) : null;
    void (async () => {
      const opened = await startup?.ready;
      if (cancelled) return;
      if (opened) { active = opened.room; return opened.meta; }
      active = new Room(fileId);
      return api<FileMeta>(`/files/${fileId}`, { signal: controller.signal });
    })().then(async (data) => {
      if (!data) return;
      if (cancelled) return;
      if (orgId !== data.workspace.clerkOrganizationId) {
        active?.close();
        await clerk.setActive({ organization: data.workspace.clerkOrganizationId });
        return;
      }
      if (cancelled) return;
      const expose = () => {
        if (cancelled || !active) return;
        if (active.status === "denied" || active.status === "gone") {
          unsubscribe?.(); setError("You no longer have access to this file."); return;
        }
        // A legacy metadata response cannot establish whether the socket will carry identity.
        // Keep listening until init arrives before deciding whether legacy fallback applies.
        if (active.status !== "open") return;
        // During a rolling deployment an old server can only use the original SDK-backed path.
        // Any identity-bearing response must match all three identities before rendering.
        if (data.principal || active.principal) {
          if (!identity || !samePrincipal(identity, data.principal) || !active.bindIdentity(identity)) {
            unsubscribe?.(); active.close(); setError("Your session changed. Reload this file to continue."); return;
          }
        }
        unsubscribe?.(); setMeta(data); setRoom(active);
      };
      unsubscribe = active!.subscribe(expose);
      expose();
    }).catch((e: Error) => {
      active?.close();
      if (cancelled || e.name === "AbortError") return;
      // The server's "not found" is terse; say what it means for the member.
      setError(e instanceof HttpError && e.status === 404 ? "It may have been deleted, or the link is incomplete." : e.message);
    });
    return () => { cancelled = true; controller.abort(); unsubscribe?.(); startup?.dispose(); active?.close(); };
  }, [fileId, userId, sessionId, orgId, clerk]);

  if (error) return <Notice title="This file couldn’t open" message={error} action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;
  if (!room || !meta) return <EditorLoading label="Opening file…" />;
  return <EditorInner room={room} meta={meta} user={meta.user}
    onChange={(file) => setMeta({ ...meta, file: { ...meta.file, ...file } })}
    onShare={(shareToken) => setMeta({ ...meta, shareToken })} />;
}

/** Before the room opens: the editor's shell and sheet around the loading canvas, so the editor arrives in place. */
function EditorLoading({ label }: { label: string }) {
  return <div className="editor shell"><main className="stage"><Loading label={label} canvas /></main></div>;
}

function EditorInner({ room, meta, user, onChange, onShare, readOnly = false }: {
  room: Room; meta: FileMeta; user: User; onChange: (f: Partial<FileInfo>) => void; onShare?: (token: string | null) => void; readOnly?: boolean;
}) {
  useSyncExternalStore(room.subscribe, room.getVersion);
  const desktop = useDesktop();
  // Phones: the collaboration notch moves to the bottom-left corner and the comments panel becomes a sheet.
  const narrow = useMediaQuery("(max-width: 700px)");
  const { file, workspace } = meta;
  const { pageId, selection: liveSelection, selectionFocus, selectPage, selectNodes, focusNodes } = useCanvasLocation(file.id, room);
  // Sections this viewer opened or closed in the pages popover; the rest follow the selection.
  const [openSections, setOpenSections] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // A marquee commits to the URL on release; until then the selection toolbar follows what it covers.
  const [marqueeSelection, setMarqueeSelection] = useState<string[] | null>(null);
  const [open, setOpen] = useState<"pages" | "file" | "share" | "people" | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [draftComment, setDraftComment] = useState<CommentAnchor | null>(null);
  const [commentFocus, setCommentFocus] = useState<{ id: string; request: number } | null>(null);
  const [dialog, setDialog] = useState<"help" | null>(null);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const playableRef = useRef<string | null>(null);
  const [hideComponents, setHideComponents] = useHiddenComponents();
  const fileTrigger = useRef<HTMLButtonElement>(null);
  const commentsTrigger = useRef<HTMLButtonElement>(null);
  const pendingFileAction = useRef<(() => void) | null>(null);
  const toggle = (panel: NonNullable<typeof open>) => (next: boolean) => setOpen(next ? panel : open === panel ? null : open);

  const page = room.pages.find((p) => p.id === pageId) ?? room.pages[0];
  // Hiding is this viewer's preference. The Design System page is where components live, so it always shows them.
  const hidingComponents = hideComponents && page?.kind !== "design-system";
  const hidden = (id: string) => hidingComponents && room.nodes.get(id)?.kind === "component";
  // A link or comment that points at a component brings components back rather than landing on nothing.
  useEffect(() => { if (selectionFocus?.ids.some(hidden)) setHideComponents(false); }, [selectionFocus]);
  // Playback ends when its design leaves the page or is deleted, on comment mode or disconnection,
  // when a member selects something else, and when the tab is hidden.
  const playingNode = interactionId ? room.nodes.get(interactionId) : undefined;
  const playbackValid = !!playingNode && canInteract(playingNode) && playingNode.pageId === page?.id && !commentMode && room.status === "open" &&
    (readOnly || liveSelection.includes(playingNode.id));
  useEffect(() => { if (interactionId && !playbackValid) setInteractionId(null); }, [interactionId, playbackValid]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setInteractionId(null); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  const closeComments = () => { setCommentsOpen(false); commentsTrigger.current?.focus({ preventScroll: true }); };
  // The tool, C and the panel's Add a comment always ask for a spot. An unposted draft is not reopened in its old
  // spot: that sent the canvas back to a design the member had left, and their next click there selected instead.
  // The click moves the draft and keeps its text (see draftKey in Comments.tsx).
  const startComment = () => {
    setActiveCommentId(null); setOpen(null);
    setCommentMode(true); setCommentsOpen(false);
  };
  const selectComment = (thread: CommentThread | null) => {
    setActiveCommentId(thread?.id ?? null); setCommentMode(false); setCommentsOpen(true);
    if (thread?.anchor.nodeId && room.nodes.get(thread.anchor.nodeId)?.kind === "component") setHideComponents(false);
    if (thread) { selectPage(thread.anchor.pageId); setCommentFocus((f) => ({ id: thread.id, request: (f?.request ?? 0) + 1 })); }
  };

  // A notification links to `?comment=<thread>`: open that thread once the file has loaded, then drop the parameter.
  const linkedComment = new URL(useLocation(), location.origin).searchParams.get("comment");
  useEffect(() => {
    if (readOnly || !linkedComment || room.status !== "open") return;
    const url = new URL(location.href);
    url.searchParams.delete("comment");
    navigate(url.pathname + url.search + url.hash, { replace: true });
    const thread = room.comments.get(linkedComment);
    if (thread) selectComment(thread);
    else toast("That comment was deleted along with its page.", { tone: "error" });
  }, [readOnly, linkedComment, room.status]);

  useEffect(() => {
    if (readOnly || interactionId) return;
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest?.("input,textarea,[contenteditable=true],[role=dialog],[role=menu]")) return;
      if (event.key === "Escape") { setCommentMode(false); setCommentsOpen(false); }
      else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat) {
        // Enter on a focused control activates that control instead.
        const playable = playableRef.current;
        if (!playable || commentMode || room.status !== "open" || (event.target as HTMLElement).closest?.("button,a,select,[role=button]")) return;
        event.preventDefault(); setInteractionId(playable);
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault(); startComment();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [readOnly, draftComment, interactionId, commentMode, room.status]);

  useEffect(() => {
    if (!page) return;
    localStorage.setItem(`sharpner:page:${file.id}`, page.id);
    room.setPresence({ pageId: page.id });
  }, [page?.id]);

  // Drop selected nodes that no longer exist, and share the selection with agents and peers.
  useEffect(() => room.setPresence({ selection: liveSelection }), [liveSelection.join(",")]);

  if (room.status === "gone") return <Notice title="This file was deleted" message="Someone in the workspace removed it." action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;
  if (room.status === "denied") return readOnly
    ? <Notice title="This link isn’t shared anymore" message="Ask someone in the workspace for a new link." action={<Button asChild size="lg"><a href="/">Open Sharpner</a></Button>} />
    : <Notice title="No access" message="You no longer have access to this file." action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;

  const renameFile = async () => {
    const name = await askText({ title: "Rename file", label: "File name", initial: file.name, confirm: "Rename" });
    if (!name || name === file.name) return;
    try {
      await api(`/files/${file.id}`, { method: "PATCH", json: { name } });
      onChange({ name });
    } catch (error) { toast((error as Error).message, { tone: "error" }); }
  };

  const people = room.status === "open" ? peopleInFile(room.peers.values(), { id: user.id, name: user.name, avatar: user.avatar_url }, page?.id ?? null) : [];
  const openComments = [...room.comments.values()].filter((t) => t.resolvedAt === null).length;
  const counts = new Map<string, number>();
  for (const n of room.nodes.values()) if (n.kind !== "section") counts.set(n.pageId, (counts.get(n.pageId) ?? 0) + 1);
  const selected = (marqueeSelection ?? liveSelection).flatMap((id) => hidden(id) ? [] : room.nodes.get(id) ?? []);
  const playable = selected.length === 1 && canInteract(selected[0]) ? selected[0]! : null;
  playableRef.current = playable?.id ?? null;
  const status = room.status === "open" ? "Live" : room.status === "connecting" ? "Connecting" : "Reconnecting";
  const commentsShown = !readOnly && commentsOpen && !commentMode;
  // Agents at work on this page, for the notch above the canvas. The frames themselves show the trace.
  const working = [...room.agentActivity].flatMap(([id, activity]) => {
    const node = room.nodes.get(id);
    return node?.pageId === page?.id && !hidden(id) ? [{ agent: activity.name, node }] : [];
  });
  const agents = [...new Set(working.map((w) => w.agent))];
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <div className={cn("editor shell", commentsShown && "comments-open")} ref={trackKeyboardInset}>
      <main className={cn("stage", commentsShown && "comments-open")}>
        {page ? (
          <Canvas key={page.id} room={room} fileId={file.id} pageId={page.id} selection={liveSelection} selectionFocus={selectionFocus} onSelect={selectNodes} onMarqueeSelection={setMarqueeSelection} readOnly={readOnly} hideComponents={hidingComponents}
            interactionId={playbackValid ? interactionId : null} onInteract={setInteractionId}
            commentMode={commentMode} onCommentMode={readOnly ? undefined : (on) => on ? startComment() : setCommentMode(false)}
            activeCommentId={activeCommentId} commentFocus={commentFocus} onOpenComment={selectComment} draftComment={commentsOpen ? draftComment : null}
            onPlaceComment={(anchor) => { setDraftComment(anchor); setActiveCommentId(null); setCommentMode(false); setCommentsOpen(true); }} />
        ) : (
          <Loading label={room.status === "offline" ? "Reconnecting…" : readOnly ? "Opening shared file…" : "Opening file…"} canvas />
        )}
        {!readOnly && commentMode ? (
          <div className={cn("comment-placement", narrow ? "floaty" : "notch notch-t")} role="status">
            <IconMessageCircle className="size-4 flex-none text-faint" aria-hidden />
            <span>Click a spot to leave a comment</span>
            <Button variant="ghost" size="sm" onClick={() => setCommentMode(false)}>Cancel</Button>
          </div>
        ) : working.length > 0 && (
          <div className={cn("agent-status", narrow ? "floaty" : "notch notch-t")} role="status">
            <span className="agent-status-mark" aria-hidden><span className="agent-sweep" /><span className="key-primary"><IconSparkles /></span></span>
            <span className="agent-status-text">
              <strong>{agents.length === 1 ? agents[0] : `${agents.length} agents`}</strong>{" "}
              <span>{agents.length === 1 ? "is" : "are"} editing {working.length === 1 ? working[0]!.node.name : `${working.length} designs`}</span>
            </span>
          </div>
        )}
        {!readOnly && !commentMode && !interactionId && selected.length > 0 && (
          <div className="selection-bar floaty" role="toolbar" aria-label="Selection" key={selected.length > 1 ? "many" : "one"} onKeyDown={stop}>
            <span className="selection-name" title={selected.length === 1 ? selected[0]!.name : undefined}>{selected.length === 1 ? selected[0]!.name : `${selected.length} selected`}</span>
            <span className="selection-agents">visible to agents</span>
            {playable && <Tooltip><TooltipTrigger asChild>
              <Button size="lg" className="selection-action" disabled={room.status !== "open"} onClick={() => setInteractionId(playable.id)}>
                <IconPlayerPlay aria-hidden />Interact<kbd className="selection-kbd" aria-hidden>↵</kbd>
              </Button>
            </TooltipTrigger><TooltipContent side="top">Try clicks, typing and scrolling. Nothing you do is saved. <Kbd>Enter</Kbd>, or click the design again.</TooltipContent></Tooltip>}
          </div>
        )}
      </main>
      {!readOnly && <CommentsPanel room={room} userId={user.id} open={commentsShown} activeId={activeCommentId} draft={draftComment}
        onSelect={selectComment} onNew={startComment} onClose={closeComments} onCancelDraft={() => setDraftComment(null)} />}
      {/* Keyboard interaction with the notches and their panels (portaled, but still React children) must not select, delete, or pan the canvas. */}
      <div className="editor-notch editor-navigation notch notch-tl" onKeyDown={stop}>
        <nav aria-label="File and pages" className="dock-bar">
          {readOnly
            ? <a href="/" aria-label="Sharpner" className="mark-tile dock-mark"><img src="/mark.svg" width={18} height={18} alt="" className="mark" /></a>
            : <Link href={`/?workspace=${workspace.id}`} aria-label="All files" className="mark-tile dock-mark"><img src="/mark.svg" width={18} height={18} alt="" className="mark" /></Link>}
          <DropdownMenu open={open === "file"} onOpenChange={toggle("file")}>
            <DropdownMenuTrigger asChild>
              <Button ref={fileTrigger} variant="ghost" size="lg" className="dock-button dock-file-button" aria-label={`File menu for ${file.name}`} title={`${file.name} · ${status}`}>
                <span>{file.name}</span>
                <span className={`dock-status ${room.status}`} aria-hidden />
                <ChevronDown className="dock-chevron" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" sideOffset={12} collisionPadding={16} className="dock-menu w-60" aria-label="File actions"
              onCloseAutoFocus={(event) => {
                const action = pendingFileAction.current;
                if (!action) return;
                // Open the dialog after the menu closes, with the persistent trigger as its focus-return target.
                event.preventDefault();
                pendingFileAction.current = null;
                fileTrigger.current?.focus();
                action();
              }}>
              <DropdownMenuLabel className="file-menu-head"><strong>{file.name}</strong><span>{readOnly ? `View only · ${status}` : `${workspace.name} · ${status}`}</span></DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!readOnly && <>
                <DropdownMenuItem onSelect={() => { pendingFileAction.current = () => void renameFile(); }}><Pencil aria-hidden />Rename file…</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>}
              <DropdownMenuCheckboxItem checked={!hideComponents} onSelect={(event) => event.preventDefault()} onCheckedChange={(show) => {
                setHideComponents(!show);
                // Hidden components leave the selection, so the toolbar and agents don't point at something off screen.
                if (!show && page?.kind !== "design-system") {
                  const kept = liveSelection.filter((id) => room.nodes.get(id)?.kind !== "component");
                  if (kept.length !== liveSelection.length) selectNodes(kept);
                }
              }}><IconComponents aria-hidden />Show components</DropdownMenuCheckboxItem>
              <DropdownMenuItem onSelect={() => { pendingFileAction.current = () => setDialog("help"); }}><IconKeyboard aria-hidden />Canvas controls</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="sr-only" role="status">{status}</span>
          <span className="dock-slash" aria-hidden>/</span>
          <DockPanel label="Pages" count={room.pages.length} open={open === "pages"} onOpenChange={toggle("pages")} className="dock-pages" side="bottom"
            trigger={
              <Button variant="ghost" size="lg" className="dock-button dock-page-button">
                <span>{page?.name ?? "Pages"}</span>
                <ChevronDown className="dock-chevron" aria-hidden />
              </Button>
            }>
            <PageList pages={room.pages} current={page?.id ?? null} counts={counts}
              outline={open === "pages" && page ? pageOutline(hidingComponents ? withoutComponents(room.pageNodes(page.id)) : room.pageNodes(page.id), { selection: liveSelection, toggled: openSections }) : []}
              onPage={(id) => { selectPage(id); setOpen(null); }}
              onToggleSection={(id, next) => setOpenSections((current) => new Map(current).set(id, next))}
              onDesign={(id) => { focusNodes([id]); setOpen(null); }} />
          </DockPanel>
        </nav>
      </div>
      {!readOnly && <div className={cn("editor-notch editor-collaboration notch", narrow ? "notch-bl" : "notch-tr")} onKeyDown={stop}>
        <nav aria-label="Collaboration" className="dock-bar">
          <DockPanel label="In this file" count={people.length} open={open === "people"} onOpenChange={toggle("people")} className="dock-people" side="bottom" align="end"
            trigger={<Button variant="ghost" size="lg" className="dock-button dock-people-button" aria-label={room.status === "open" ? `${people.length} ${people.length === 1 ? "person" : "people"} in this file` : "Reconnecting to people in this file"}
              title={people.map((p) => p.id === user.id ? `${p.name} (you)` : p.name).join(", ") || "Reconnecting…"}>
              <AvatarStack max={desktop ? 4 : 2} size={24}>{people.length
                ? people.map((p) => <Avatar key={p.id} id={p.id} name={p.name} src={p.avatar} />)
                : <Avatar id={user.id} name={user.name} src={user.avatar_url} />}</AvatarStack>
              <span className={`presence-dot${room.status !== "open" ? " disconnected" : ""}`} aria-hidden />
            </Button>}>
            {people.map((person) => <Button key={person.id} variant="ghost" className="person-row" onClick={() => {
              const target = person.pageIds.includes(page?.id ?? "") ? page?.id : person.pageIds[0];
              if (target) { selectPage(target); setOpen(null); }
            }}>
              <Avatar id={person.id} name={person.name} src={person.avatar} />
              <span><strong>{person.name}{person.id === user.id ? " (you)" : ""}</strong><small>{person.pageIds.map((id) => room.pages.find((p) => p.id === id)?.name).filter(Boolean).join(", ") || "Opening file…"}</small></span>
              <span className="presence-dot" aria-label="Online" />
            </Button>)}
            {room.status !== "open" && <p className="text-xs text-muted-foreground">Reconnecting to see who’s here…</p>}
            {room.agentActivity.size > 0 && <div className="agent-presence well">
              <span className="agent-status-mark" aria-hidden><span className="agent-sweep" /><span className="key-primary"><IconSparkles /></span></span>
              An agent is working in this file
            </div>}
          </DockPanel>
          <NotificationBell size="lg" className="dock-button" side="bottom" onOpenChange={(next) => { if (next) setOpen(null); }} />
          <Button ref={commentsTrigger} variant="ghost" size="lg" className="dock-button dock-comments-button" aria-label={`Comments, ${openComments} open`} aria-pressed={commentsOpen || commentMode}
            aria-expanded={commentsShown} aria-controls="comments-panel"
            title="Comments (C to add)" onClick={() => { setCommentsOpen((value) => !value); setCommentMode(false); setOpen(null); }}>
            <IconMessageCircle aria-hidden /><span className="dock-comments-count">{openComments > 99 ? "99+" : openComments || ""}</span>
          </Button>
          <DockPanel label="Share" open={open === "share"} onOpenChange={toggle("share")} className="dock-share" side="bottom" align="end"
            trigger={
              <Button size={narrow ? "icon-lg" : "lg"} className="dock-share-button" aria-label="Share file">
                {narrow ? <Link2 aria-hidden /> : <span className="dock-share-label">Share</span>}
                {meta.shareToken && <span className="share-on-dot" aria-label="Link sharing is on" role="img" />}
              </Button>
            }>
            <ShareLink fileId={file.id} token={meta.shareToken} view={{ pageId, selection: liveSelection }} onChange={(token) => onShare?.(token)} />
          </DockPanel>
        </nav>
      </div>}
      <ResponsiveDialog title="Canvas controls" open={dialog === "help"} onOpenChange={(next) => setDialog(next ? "help" : null)}>
        <div className="canvas-help">
          <div className="touch-help">
            <dl>
              <dt>Pan</dt><dd>Drag with one finger</dd>
              <dt>Zoom</dt><dd>Pinch with two fingers</dd>
              {!readOnly && <><dt>Select</dt><dd>Tap a design to show it to agents</dd></>}
              <dt>Fit</dt><dd>Fit button, or double-tap a design</dd>
              <dt>Interact</dt><dd>{readOnly ? "Try a design’s clicks and typing" : "Tap a selected design"}; Stop returns to the canvas</dd>
            </dl>
            {!readOnly && <p>The canvas is view only. Ask an agent to add, move or remove designs.</p>}
          </div>
          <div className="keyboard-help">
            <dl>
              <dt>Pan</dt><dd>Drag, scroll, or hold Space</dd>
              <dt>Zoom</dt><dd>Pinch, <Kbd>⌘</Kbd> scroll, <Kbd>⌘+</Kbd> / <Kbd>⌘−</Kbd></dd>
              <dt>Fit all / selection</dt><dd><Kbd>⇧1</Kbd> / <Kbd>⇧2</Kbd>, double-click</dd>
              <dt>Interact</dt><dd>{readOnly ? "Try a design’s clicks and typing" : <><Kbd>Enter</Kbd>, or click a selected design</>}; <Kbd>Esc</Kbd> stops, Reset starts again</dd>
              {!readOnly && <>
                <dt>Select</dt><dd>Click, ⇧ click, ⇧ drag, to show designs to agents</dd>
                <dt>Comment</dt><dd><Kbd>C</Kbd>, then click a spot</dd>
              </>}
            </dl>
            {!readOnly && <p>The canvas is view only. Ask an agent to add, move or remove designs.</p>}
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/**
 * One notch control and its panel: a popover under its notch on wide screens, a bottom sheet on phones.
 * The panel's label is its one visible heading, so content inside never repeats it.
 */
function DockPanel({ label, count, action, open, onOpenChange, onEscapeKeyDown, trigger, className, side = "top", align = "start", children }: {
  label: string; count?: number; action?: ReactNode; open: boolean; onOpenChange: (open: boolean) => void;
  onEscapeKeyDown?: (e: globalThis.KeyboardEvent) => void; trigger: ReactElement; className?: string; side?: "top" | "bottom"; align?: "start" | "end"; children: ReactNode;
}) {
  const desktop = useDesktop();
  const content = useRef<HTMLDivElement>(null);
  const change = (next: boolean) => {
    // Commit an edited name before closing removes its input.
    if (!next && content.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    onOpenChange(next);
  };
  // Keep the panel open while a confirmation it started (a modal elsewhere in the tree) has focus.
  const keepForModal = (e: Event) => { if ((e.target as Element | null)?.closest?.("[data-slot=dialog-content], [data-slot=drawer-content], [data-slot=alert-dialog-content]")) e.preventDefault(); };
  const heading = (Title: typeof DrawerTitle | "h2") => (
    <div className="dock-panel-head">
      <Title className="dock-panel-title">{label}{count !== undefined && <span className="dock-panel-count" aria-label={`${count} total`}>{count}</span>}</Title>
      {action}
    </div>
  );
  if (desktop) return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent ref={content} side={side} align={align} sideOffset={12} collisionPadding={16} aria-label={label}
        onEscapeKeyDown={onEscapeKeyDown} onFocusOutside={keepForModal} onInteractOutside={keepForModal}
        className={cn("dock-popover w-[320px] gap-0 p-0", className)}>
        {heading("h2")}
        <div className="dock-panel-body">{children}</div>
      </PopoverContent>
    </Popover>
  );
  return (
    <Drawer open={open} onOpenChange={change} autoFocus>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent ref={content} onEscapeKeyDown={onEscapeKeyDown} aria-describedby={undefined}
        className={cn("dock-popover", className)}>
        {heading(DrawerTitle)}
        <div className="dock-panel-body">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

const designCount = (n: number) => `${n} design${n === 1 ? "" : "s"}`;

/**
 * Every page of the file, and the current page's outline: its sections, with the screens of open sections.
 * Members only navigate here; agents add, rename, reorder and delete pages.
 */
function PageList({ pages, current, counts, outline, onPage, onToggleSection, onDesign }: {
  pages: Page[]; current: string | null; counts: ReadonlyMap<string, number>; outline: OutlineItem[];
  onPage: (id: string) => void; onToggleSection: (id: string, open: boolean) => void; onDesign: (id: string) => void;
}) {
  const tree = (items: OutlineItem[]): ReactNode => items.map((item) => item.kind === "section" ? (
    <li key={item.node.id} className="outline-section">
      <button type="button" className="outline-row outline-section-row" aria-expanded={item.open} onClick={() => onToggleSection(item.node.id, !item.open)}
        title={item.node.description || item.node.name}>
        <ChevronDown className="outline-chevron" aria-hidden /><span className="truncate">{item.node.name}</span>
        <span className="outline-count" aria-label={designCount(item.count)}>{item.count}</span>
      </button>
      {item.open && item.children.length > 0 && <ul className="outline-children">{tree(item.children)}</ul>}
    </li>
  ) : (
    <li key={item.node.id}>
      <button type="button" className="outline-row outline-design" aria-current={item.selected || undefined} onClick={() => onDesign(item.node.id)}>
        <span className="truncate">{item.node.name}</span>{item.selected && <span className="outline-selected">selected</span>}
      </button>
    </li>
  ));
  return (
    <ul className="page-list" aria-label="Pages">
      {pages.map((p) => {
        const Icon = p.kind === "design-system" ? IconLayoutGrid : FileText;
        const active = p.id === current;
        return <li key={p.id} className="page-item">
          <button type="button" className={cn("page-option", active && "key")} aria-current={active ? "page" : undefined} onClick={() => onPage(p.id)}>
            <Icon className="page-icon" aria-hidden />
            <span className="page-option-text">
              <span className="truncate">{p.name}{p.kind === "design-system" && <span className="sr-only"> · Design System page</span>}</span>
              {p.description && <span className="page-description" title={p.description}>{p.description}</span>}
            </span>
            <span className="page-count" aria-label={designCount(counts.get(p.id) ?? 0)}>{counts.get(p.id) ?? 0}</span>
          </button>
          {active && outline.length > 0 && <ul className="page-outline" aria-label={`Sections on ${p.name}`}>{tree(outline)}</ul>}
        </li>;
      })}
    </ul>
  );
}

/**
 * Publishes how much of the layout viewport the on-screen keyboard covers as `--keyboard`,
 * so the dock and its sheets stay above it while renaming. A ref callback: no state, no re-render.
 */
function trackKeyboardInset(el: HTMLElement | null) {
  const vv = window.visualViewport;
  if (!el || !vv) return;
  const update = () => el.style.setProperty("--keyboard", `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
}

const HIDE_COMPONENTS_KEY = "sharpner:hide-components";

/** Whether this browser hides component nodes outside the Design System page. One setting for every file. */
function useHiddenComponents() {
  const [hide, setHide] = useState(() => { try { return localStorage.getItem(HIDE_COMPONENTS_KEY) === "1"; } catch { return false; } });
  const update = (next: boolean) => {
    setHide(next);
    try { next ? localStorage.setItem(HIDE_COMPONENTS_KEY, "1") : localStorage.removeItem(HIDE_COMPONENTS_KEY); } catch { /* private mode keeps it for this tab */ }
  };
  return [hide, update] as const;
}

/** View-only link sharing for a file: off, or one link anyone can open to watch. */
function ShareLink({ fileId, token, view, onChange }: { fileId: string; token: string | null; view: CanvasLocation; onChange: (token: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (t: string) => {
    try { await navigator.clipboard.writeText(shareUrl(t, view)); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1400); }
    catch { toast("Could not copy. Select the link to copy it manually.", { tone: "error" }); }
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); }
  };
  return (
    <section className="share" aria-label="Link sharing">
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{token ? "Anyone with this link can view this file." : "Create a link to let anyone view this file."}</p>
      {token ? (
        <>
          <Input className="share-url" readOnly value={shareUrl(token, view)} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
          <div className="share-actions">
            <Button variant="secondary" className={cn("flex-1", copied && "copy-done")} disabled={busy} onClick={() => void copy(token)} aria-live="polite">
              {copied ? <><Check aria-hidden />Copied</> : "Copy link"}
            </Button>
            <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void run(async () => {
              if (!await askConfirm({ title: "Turn off link sharing?", message: "The link stops working and anyone watching through it is disconnected.", confirm: "Turn off", danger: true })) return;
              await api(`/files/${fileId}/share`, { method: "DELETE" });
              onChange(null);
            })}>Turn off</Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" className="w-full" disabled={busy} onClick={() => void run(async () => {
          const { shareToken } = await api<{ shareToken: string }>(`/files/${fileId}/share`, { method: "PUT" });
          onChange(shareToken);
          await copy(shareToken);
        })}>{busy ? "Creating link…" : "Create link"}</Button>
      )}
    </section>
  );
}
