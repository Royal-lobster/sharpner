import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { IconCheck as Check, IconChevronDown as ChevronDown, IconChevronUp as ChevronUp, IconFileText as FileText, IconLink as Link2, IconPencil as Pencil, IconPlus as Plus, IconTrash as Trash2, IconSparkles, IconKeyboard, IconLibrary } from "@tabler/icons-react";
import { useAuth, useClerk } from "@clerk/react";
import { api, colorFor, type FileInfo, type User, type Workspace } from "./api";
import { Canvas } from "./Canvas";
import { Room } from "./room";
import { Link } from "./router";
import { askConfirm, askText, ResponsiveDialog } from "./dialog";
import { Loading, Notice } from "./states";
import { toast } from "./toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ButtonGroup } from "@/components/ui/button-group";
import { Separator } from "@/components/ui/separator";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Item, ItemGroup, ItemActions } from "@/components/ui/item";
import { Avatar as AvatarRoot, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";

type FileMeta = { user: User; file: FileInfo; workspace: Workspace; files: { id: string; name: string }[]; shareToken: string | null };
type SharedMeta = { file: { id: string; name: string }; workspace: { name: string } };

const shareUrl = (token: string) => `${location.origin}/s/${token}`;

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
  if (!room || !meta) return <Loading label="Opening shared file…" />;
  return <EditorInner room={room} meta={meta} user={meta.user} readOnly onChange={() => {}} />;
}

export function Editor({ fileId }: { fileId: string }) {
  const { orgId } = useAuth();
  const clerk = useClerk();
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    let cancelled = false;
    let active: Room | null = null;
    const controller = new AbortController();
    setMeta(null); setRoom(null); setError(null);
    api<FileMeta>(`/files/${fileId}`, { signal: controller.signal }).then(async (data) => {
      if (cancelled) return;
      if (orgId !== data.workspace.clerkOrganizationId) {
        await clerk.setActive({ organization: data.workspace.clerkOrganizationId });
        return;
      }
      if (cancelled) return;
      setMeta(data);
      active = new Room(fileId);
      setRoom(active);
    }).catch((e: Error) => { if (!cancelled && e.name !== "AbortError") setError(e.message); });
    return () => { cancelled = true; controller.abort(); active?.close(); };
  }, [fileId, orgId, clerk]);

  if (error) return <Notice title="This file couldn’t open" message={error} action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;
  if (!room || !meta) return <Loading label="Opening file…" />;
  return <EditorInner room={room} meta={meta} user={meta.user}
    onChange={(file) => setMeta({ ...meta, file: { ...meta.file, ...file } })}
    onShare={(shareToken) => setMeta({ ...meta, shareToken })} />;
}

function EditorInner({ room, meta, user, onChange, onShare, readOnly = false }: {
  room: Room; meta: FileMeta; user: User; onChange: (f: Partial<FileInfo>) => void; onShare?: (token: string | null) => void; readOnly?: boolean;
}) {
  useSyncExternalStore(room.subscribe, room.getVersion);
  const { file, workspace } = meta;
  const [pageId, setPageId] = useState<string | null>(() => localStorage.getItem(`sharpner:page:${file.id}`));
  const [selection, setSelection] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<"pages" | "file" | "share" | null>(null);
  const [dialog, setDialog] = useState<"library" | "help" | null>(null);
  const fileTrigger = useRef<HTMLButtonElement>(null);
  const pendingFileAction = useRef<(() => void) | null>(null);
  const cancelRename = useRef(false);
  const toggle = (panel: NonNullable<typeof open>) => (next: boolean) => setOpen(next ? panel : open === panel ? null : open);

  const page = room.pages.find((p) => p.id === pageId) ?? room.pages[0];

  useEffect(() => {
    if (!page) return;
    localStorage.setItem(`sharpner:page:${file.id}`, page.id);
    room.setPresence({ pageId: page.id });
  }, [page?.id]);

  // Drop selected nodes that no longer exist, and share the selection with agents and peers.
  const liveSelection = selection.filter((id) => room.nodes.has(id));
  useEffect(() => room.setPresence({ selection: liveSelection }), [liveSelection.join(",")]);

  if (room.status === "gone") return <Notice title="This file was deleted" message="Someone in the workspace removed it." action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;
  if (room.status === "denied") return readOnly
    ? <Notice title="This link isn’t shared anymore" message="Ask someone in the workspace for a new link." action={<Button asChild size="lg"><a href="/">Open Sharpner</a></Button>} />
    : <Notice title="No access" message="You no longer have access to this file." action={<Button asChild size="lg"><Link href="/">Back to files</Link></Button>} />;

  const addPage = () => {
    const id = crypto.randomUUID();
    room.send([{ t: "page.put", page: { id, name: `Page ${room.pages.length + 1}`, sort: Math.max(0, ...room.pages.map((p) => p.sort)) + 1 } }]);
    setPageId(id);
    setRenaming(id);
  };

  const renameFile = async () => {
    const name = await askText({ title: "Rename file", label: "File name", initial: file.name, confirm: "Rename" });
    if (!name || name === file.name) return;
    try {
      await api(`/files/${file.id}`, { method: "PATCH", json: { name } });
      onChange({ name });
    } catch (error) { toast((error as Error).message, { tone: "error" }); }
  };

  // One avatar per person, even with several tabs open.
  const peers = [...new Map([...room.peers.values()].filter((p) => p.id !== user.id).map((p) => [p.id, p])).values()];
  const counts = new Map<string, number>();
  for (const n of room.nodes.values()) if (n.kind !== "section") counts.set(n.pageId, (counts.get(n.pageId) ?? 0) + 1);
  const selected = liveSelection.map((id) => room.nodes.get(id)!);
  const status = room.status === "open" ? "Live" : room.status === "connecting" ? "Connecting" : "Reconnecting";
  const deletePage = async (p: { id: string; name: string }) => {
    const n = counts.get(p.id) ?? 0;
    const ok = await askConfirm({
      title: `Delete “${p.name}”?`, confirm: "Delete page", danger: true,
      message: n ? `Its ${n === 1 ? "design" : `${n} designs`} will be removed for everyone. This can’t be undone.` : "This page is empty.",
    });
    if (ok) room.send([{ t: "page.del", id: p.id }]);
  };
  return (
    <div className="editor" ref={trackKeyboardInset}>
      <main className="stage">
        {page ? (
          <Canvas key={page.id} room={room} fileId={file.id} pageId={page.id} selection={liveSelection} onSelect={setSelection} readOnly={readOnly} />
        ) : (
          <Loading label="Connecting…" />
        )}
        {selected.length > 0 && (
          <Badge variant="secondary" className="selection-pill canvas-glass" key={selected.length > 1 ? "many" : "one"}>
            <span className="truncate">{selected.length === 1 ? selected[0]!.name : `${selected.length} selected`}</span><b>· visible to agents</b>
          </Badge>
        )}
      </main>
      {/* Keyboard interaction with the dock and its panels (portaled, but still React children) must not select, delete, or pan the canvas. */}
      <div className="editor-dock" onKeyDown={(e) => e.stopPropagation()}>
        <nav aria-label="File and pages"><ButtonGroup className="dock-bar canvas-glass">
          {readOnly ? (
            <Button variant="ghost" size="icon" asChild className="back"><a href="/" aria-label="Sharpner"><img src="/mark.svg" width={24} height={24} alt="" /></a></Button>
          ) : (
            <Button variant="ghost" size="icon" asChild className="back"><Link href={`/?workspace=${workspace.id}`} aria-label="All files"><img src="/mark.svg" width={24} height={24} alt="" /></Link></Button>
          )}
          <DropdownMenu open={open === "file"} onOpenChange={toggle("file")}>
            <DropdownMenuTrigger asChild>
              <Button ref={fileTrigger} variant="ghost" className="dock-button dock-file-button" aria-label={`File menu for ${file.name}`} title={`${file.name} · ${status}`}>
                <span>{file.name}</span>
                <span className={`status dock-status ${room.status}`} aria-hidden />
                <ChevronDown className="dock-chevron size-3" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={10} collisionPadding={16} className="canvas-glass w-56" aria-label="File actions"
              onCloseAutoFocus={(event) => {
                const action = pendingFileAction.current;
                if (!action) return;
                // Open the dialog after the menu closes, with the persistent trigger as its focus-return target.
                event.preventDefault();
                pendingFileAction.current = null;
                fileTrigger.current?.focus();
                action();
              }}>
              {readOnly ? <DropdownMenuLabel>View only</DropdownMenuLabel> : <>
                <DropdownMenuItem onSelect={() => { pendingFileAction.current = () => void renameFile(); }}><Pencil aria-hidden />Rename file…</DropdownMenuItem>
                {(meta.files.length > 0 || file.library_id) && <DropdownMenuItem onSelect={() => { pendingFileAction.current = () => setDialog("library"); }}><IconLibrary aria-hidden />Design system…</DropdownMenuItem>}
                <DropdownMenuSeparator />
              </>}
              <DropdownMenuItem onSelect={() => { pendingFileAction.current = () => setDialog("help"); }}><IconKeyboard aria-hidden />Canvas controls</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="sr-only" role="status">{status}</span>
          <Separator orientation="vertical" className="dock-divider" />
          <DockPanel label="Pages" count={room.pages.length} open={open === "pages"} onOpenChange={toggle("pages")} className="dock-pages"
            action={!readOnly && <Button variant="secondary" size="sm" onClick={addPage}><Plus aria-hidden />Add page</Button>}
            // Escape while renaming cancels the rename instead of closing the panel.
            onEscapeKeyDown={(e) => { if (renaming) { e.preventDefault(); cancelRename.current = true; setRenaming(null); } }}
            trigger={
              <Button variant="ghost" className="dock-button dock-page-button">
                <FileText className="size-4" aria-hidden />
                <span>{page?.name ?? "Pages"}</span>
                <ChevronUp className="dock-chevron size-3" aria-hidden />
              </Button>
            }>
            <ItemGroup className="page-list gap-1">
              {room.pages.map((p) => (
                <Item role="listitem" size="xs" key={p.id} className={cn("page-item flex-nowrap gap-1 p-0", p.id === page?.id && "bg-muted")}>
                  {renaming === p.id ? (
                    <Input autoFocus aria-label="Page name" defaultValue={p.name} enterKeyHint="done" onFocus={(e) => { cancelRename.current = false; e.currentTarget.select(); }}
                      onBlur={(e) => {
                        setRenaming(null);
                        const name = e.target.value.trim();
                        if (!cancelRename.current && name && name !== p.name) room.send([{ t: "page.put", page: { ...p, name } }]);
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    />
                  ) : (
                    <Button variant="ghost" className="page-option" aria-current={p.id === page?.id ? "page" : undefined} onClick={() => { setPageId(p.id); setSelection([]); setOpen(null); }}>
                      <span className="truncate">{p.name}</span><Badge variant="secondary" aria-label={`${counts.get(p.id) ?? 0} designs`}>{counts.get(p.id) ?? 0}</Badge>
                    </Button>
                  )}
                  {!readOnly && renaming !== p.id && <ItemActions className="page-actions">
                    <IconAction label={`Rename ${p.name}`} onClick={() => setRenaming(p.id)}><Pencil aria-hidden /></IconAction>
                    {room.pages.length > 1 && <IconAction label={`Delete ${p.name}`} onClick={() => void deletePage(p)}><Trash2 aria-hidden /></IconAction>}
                  </ItemActions>}
                </Item>
              ))}
            </ItemGroup>
          </DockPanel>
          {!readOnly && <>
            <Separator orientation="vertical" className="dock-divider dock-share-divider" />
            <DockPanel label="Share" open={open === "share"} onOpenChange={toggle("share")} className="dock-share"
              trigger={
                <Button variant="ghost" className="dock-button dock-share-button" aria-label="Share file">
                  <Link2 className="size-4" aria-hidden />
                  <span className="dock-share-label">Share</span>{meta.shareToken && <span className="share-on-dot" aria-label="Link sharing is on" role="img" />}
                </Button>
              }>
              <ShareLink fileId={file.id} token={meta.shareToken} onChange={(token) => onShare?.(token)} />
              {(peers.length > 0 || room.agentActivity.size > 0) && <>
                <Separator />
                <div className="dock-presence">
                  <span className="text-xs text-muted-foreground">In this file</span>
                  <AvatarGroup>
                    {peers.slice(0, 4).map((p) => <Avatar key={p.cid} name={p.name} id={p.id} src={p.avatar} />)}
                    {peers.length > 4 && <AvatarGroupCount title={peers.slice(4).map((p) => p.name).join(", ")}>+{peers.length - 4}</AvatarGroupCount>}
                    {room.agentActivity.size > 0 && <Avatar name="Agent" id="agent" src={null} title="An agent is editing" agent />}
                  </AvatarGroup>
                </div>
              </>}
            </DockPanel>
          </>}
        </ButtonGroup></nav>
      </div>
      {!readOnly && <LibraryDialog file={file} files={meta.files} open={dialog === "library"} onOpenChange={(next) => setDialog(next ? "library" : null)} onChange={(libraryId) => onChange({ library_id: libraryId })} />}
      <ResponsiveDialog title="Canvas controls" open={dialog === "help"} onOpenChange={(next) => setDialog(next ? "help" : null)}>
        <div className="canvas-help">
          <div className="touch-help">
            <dl>
              <dt>Pan</dt><dd>Drag with one finger</dd>
              <dt>Zoom</dt><dd>Pinch with two fingers</dd>
              {!readOnly && <><dt>Select</dt><dd>Tap a design to show it to agents</dd></>}
              <dt>Fit</dt><dd>Fit button, or double-tap a design</dd>
            </dl>
            {!readOnly && <p>Designs can’t be moved by touch, so navigating never rearranges a page.</p>}
          </div>
          <div className="keyboard-help">
            <dl>
              <dt>Pan</dt><dd>Drag, scroll, or hold Space</dd>
              <dt>Zoom</dt><dd>Pinch, <Kbd>⌘</Kbd> scroll, <Kbd>⌘+</Kbd> / <Kbd>⌘−</Kbd></dd>
              <dt>Fit all / selection</dt><dd><Kbd>⇧1</Kbd> / <Kbd>⇧2</Kbd>, double-click</dd>
              {!readOnly && <>
                <dt>Select</dt><dd>Click, ⇧ click, ⇧ drag</dd>
                <dt>Images</dt><dd>Drop or paste</dd>
                <dt>Delete</dt><dd>⌫</dd>
              </>}
            </dl>
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  );
}

/**
 * One dock control and its panel: a popover above the dock on wide screens, a bottom sheet on phones.
 * The panel's label is its one visible heading, so content inside never repeats it.
 */
function DockPanel({ label, count, action, open, onOpenChange, onEscapeKeyDown, trigger, className, children }: {
  label: string; count?: number; action?: ReactNode; open: boolean; onOpenChange: (open: boolean) => void;
  onEscapeKeyDown?: (e: globalThis.KeyboardEvent) => void; trigger: ReactElement; className?: string; children: ReactNode;
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
      <Title className="dock-panel-title">{label}{count !== undefined && <Badge variant="secondary" aria-label={`${count} total`}>{count}</Badge>}</Title>
      {action}
    </div>
  );
  if (desktop) return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent ref={content} side="top" align="start" sideOffset={10} collisionPadding={16} aria-label={label}
        onEscapeKeyDown={onEscapeKeyDown} onFocusOutside={keepForModal} onInteractOutside={keepForModal}
        className={cn("dock-popover canvas-glass w-[340px] gap-0 p-0", className)}>
        {heading("h2")}
        <div className="dock-panel-body">{children}</div>
      </PopoverContent>
    </Popover>
  );
  return (
    <Drawer open={open} onOpenChange={change} autoFocus>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent ref={content} onEscapeKeyDown={onEscapeKeyDown} aria-describedby={undefined}
        className={cn("dock-popover canvas-glass", className)}>
        {heading(DrawerTitle)}
        <div className="dock-panel-body">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground max-sm:size-11 pointer-coarse:size-11" aria-label={label} onClick={onClick}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function LibraryDialog({ file, files, open, onOpenChange, onChange }: {
  file: FileInfo; files: FileMeta["files"]; open: boolean; onOpenChange: (open: boolean) => void; onChange: (libraryId: string | null) => void;
}) {
  const [libraryId, setLibraryId] = useState(file.library_id ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setLibraryId(file.library_id ?? ""); }, [open, file.library_id]);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/files/${file.id}`, { method: "PATCH", json: { libraryId: libraryId || null } });
      onChange(libraryId || null);
      onOpenChange(false);
      const name = files.find((f) => f.id === libraryId)?.name;
      toast(name ? `Using ${name}'s design system` : "Using this file's own design system", { tone: "success" });
    } catch (error) { toast((error as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  };
  return (
    <ResponsiveDialog title="Design system" description="Reuse another file’s tokens and components." open={open} onOpenChange={onOpenChange}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form="file-library-form" disabled={busy || libraryId === (file.library_id ?? "")}>{busy ? "Saving…" : "Save"}</Button>
      </>}>
      <form id="file-library-form" onSubmit={(event) => { event.preventDefault(); if (!busy && libraryId !== (file.library_id ?? "")) void save(); }}>
        <Field>
          <FieldLabel htmlFor="file-library">Source file</FieldLabel>
          <NativeSelect id="file-library" data-autofocus className="w-full" value={libraryId} disabled={busy} onChange={(event) => setLibraryId(event.target.value)}>
            <NativeSelectOption value="">This file</NativeSelectOption>
            {file.library_id && !files.some((f) => f.id === file.library_id) && <NativeSelectOption value={file.library_id} disabled>Linked file unavailable</NativeSelectOption>}
            {files.map((f) => <NativeSelectOption key={f.id} value={f.id}>{f.name}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      </form>
    </ResponsiveDialog>
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

export function Avatar({ name, id, src, title, agent }: { name: string; id: string; src: string | null; title?: string; agent?: boolean }) {
  return (
    <AvatarRoot title={title ?? name}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback style={{ backgroundColor: agent ? "var(--primary)" : colorFor(id), color: "var(--primary-foreground)" }}>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      {agent && <AvatarBadge><IconSparkles aria-label="Agent" /></AvatarBadge>}
    </AvatarRoot>
  );
}

/** View-only link sharing for a file: off, or one link anyone can open to watch. */
function ShareLink({ fileId, token, onChange }: { fileId: string; token: string | null; onChange: (token: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (t: string) => {
    try { await navigator.clipboard.writeText(shareUrl(t)); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1400); }
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
          <Input className="share-url" readOnly value={shareUrl(token)} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
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
