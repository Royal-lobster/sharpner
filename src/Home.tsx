import { CreateOrganization, OrganizationSwitcher, UserButton, useClerk } from "@clerk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentConnectionConfig, Me } from "./App";
import { api, timeAgo, type FileSummary, type Workspace } from "./api";
import { Link, navigate } from "./router";
import { askConfirm, askText } from "./dialog";
import { toast } from "./toast";
import { IconAlertCircle, IconDots, IconFile, IconFolder, IconLayout2, IconLibrary, IconPencil, IconPlus, IconSearch, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardFooter, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

type WorkspaceDetail = { workspace: Workspace; files: FileSummary[] };

export function Home({ me, agentConfig }: { me: Me; agentConfig: AgentConnectionConfig }) {
  const clerk = useClerk();
  const current = me.workspaces.find((w) => w.id === me.activeWorkspaceId);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(() => current ? { workspace: current, files: me.files } : null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "libraries">("all");
  const [agentOpen, setAgentOpen] = useState(false);
  const [AgentSettings, setAgentSettings] = useState<typeof import("./AgentSettings").AgentSettings | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const openingAgent = useRef(false);
  const [creating, setCreating] = useState(false);
  const alive = useRef(true);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    if (!current) return;
    const seq = ++sequence.current;
    const data = await api<WorkspaceDetail>(`/workspaces/${current.id}`);
    if (alive.current && seq === sequence.current) setDetail(data);
  }, [current?.id]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    if (me.activeWorkspaceId || !me.workspaces.length) return;
    void clerk.setActive({ organization: me.workspaces[0]!.clerkOrganizationId }).catch((e: Error) => setError(e.message));
  }, [clerk, me.activeWorkspaceId, me.workspaces]);

  const openAgent = async (trigger: HTMLButtonElement) => {
    if (openingAgent.current) return;
    if (AgentSettings) { setAgentOpen(true); return; }
    openingAgent.current = true;
    setAgentLoading(true);
    // Keep the initiating control available as the dialog's focus-return target.
    trigger.focus({ preventScroll: true });
    try {
      const module = await import("./AgentSettings");
      if (!alive.current || !trigger.isConnected) return;
      trigger.focus({ preventScroll: true });
      setAgentSettings(() => module.AgentSettings);
      setAgentOpen(true);
    } catch {
      if (alive.current) toast("Agent settings could not load. Refresh the page and try again.", { tone: "error" });
    } finally {
      openingAgent.current = false;
      if (alive.current) setAgentLoading(false);
    }
  };

  const newFile = async () => {
    if (!current) return;
    const name = await askText({ title: "New file", label: "File name", initial: "Untitled", confirm: "Create file" });
    if (name === null) return;
    setCreating(true); setError(null);
    try {
      const file = await api<{ id: string }>(`/workspaces/${current.id}/files`, { method: "POST", json: { name } });
      navigate(`/f/${file.id}`);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };
  const files = detail?.files ?? [];
  const libraries = files.filter((f) => f.used_by > 0);
  const names = new Map(files.map((f) => [f.id, f.name]));
  const visible = files.filter((f) => (view === "all" || f.used_by > 0) && f.name.toLowerCase().includes(query.trim().toLowerCase()));

  const renameFile = async (file: FileSummary) => {
    const name = await askText({ title: "Rename file", label: "File name", initial: file.name, confirm: "Rename" });
    if (name === null || name === file.name) return;
    try { await api(`/files/${file.id}`, { method: "PATCH", json: { name } }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const deleteFile = async (file: FileSummary) => {
    const ok = await askConfirm({
      title: `Delete “${file.name}”?`, confirm: "Delete file", danger: true,
      message: file.used_by > 0
        ? `${file.used_by === 1 ? "One file uses" : `${file.used_by} files use`} its design system. Its pages and designs are removed for everyone in ${current?.name ?? "this workspace"}. This can’t be undone.`
        : `Its pages and designs are removed for everyone in ${current?.name ?? "this workspace"}. This can’t be undone.`,
    });
    if (!ok) return;
    try { await api(`/files/${file.id}`, { method: "DELETE" }); toast(`Deleted ${file.name}`, { tone: "success" }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-inner">
          <Button variant="ghost" size="icon" asChild className="brand"><Link href="/" aria-label="Sharpner home"><img src="/mark.svg" width={26} height={26} alt="" /></Link></Button>
          <span className="home-header-divider" aria-hidden>/</span>
          <OrganizationSwitcher hidePersonal organizationProfileMode="modal" createOrganizationMode="modal"
            afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/"
            appearance={{ elements: { rootBox: "workspace-switcher", organizationSwitcherTrigger: "workspace-trigger", organizationPreviewMainIdentifier: "workspace-name", organizationPreviewAvatarBox: "workspace-avatar" } }} />
          <div className="home-header-actions">
            <Button variant="ghost" onClick={(e) => void openAgent(e.currentTarget)} aria-disabled={agentLoading} aria-busy={agentLoading} aria-label="Connect an agent" title="Connect an agent">
              {agentLoading ? <Spinner aria-hidden /> : <IconTerminal2 aria-hidden />}<span className="hidden sm:inline">Connect agent</span>
            </Button>
            <UserButton />
          </div>
        </div>
      </header>
      <main className="home-main">
        {!me.workspaces.length ? (
          <section className="workspace-onboarding rise">
            <Empty className="flex-none p-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><IconFolder aria-hidden /></EmptyMedia>
                <EmptyTitle role="heading" aria-level={1}>Create a workspace</EmptyTitle>
                <EmptyDescription>Keep your files, shared libraries, and members together.</EmptyDescription>
              </EmptyHeader>
            </Empty>
            <CreateOrganization routing="hash" afterCreateOrganizationUrl="/" appearance={{ elements: { rootBox: "onboarding-clerk", cardBox: "onboarding-card" } }} />
          </section>
        ) : !current ? (
          error ? <Alert variant="destructive"><IconAlertCircle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert> : <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground" role="status"><Spinner aria-hidden />{me.activeWorkspaceId ? "Choose an available workspace from the menu above." : "Opening your workspace…"}</div>
        ) : (
          <Tabs key={current.id} value={view} onValueChange={(value) => setView(value as typeof view)} className="dashboard fade-in">
            <div className="home-head">
              <div className="home-title">
                <h1>Files</h1>
                {detail && <Badge variant="secondary" aria-label={`${files.length} files`}>{files.length}</Badge>}
              </div>
              <TabsList className="[grid-area:tabs]" aria-label="File views">
                <TabsTrigger value="all">All files <Badge variant="secondary">{files.length}</Badge></TabsTrigger>
                <TabsTrigger value="libraries">Libraries <Badge variant="secondary">{libraries.length}</Badge></TabsTrigger>
              </TabsList>
              <InputGroup className="[grid-area:search]">
                <InputGroupAddon><IconSearch aria-hidden /></InputGroupAddon>
                <InputGroupInput aria-label="Search files" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files" type="search" enterKeyHint="search" />
              </InputGroup>
              <Button className="new-file" onClick={newFile} disabled={creating} aria-label="New file">
                {creating ? <Spinner aria-hidden /> : <IconPlus aria-hidden />}
                <span className="new-file-long">{creating ? "Creating…" : "New file"}</span><span className="new-file-short" aria-hidden>{creating ? "…" : "New"}</span>
              </Button>
            </div>
            <TabsContent value={view}>
            {error && <Alert variant="destructive" className="mb-4"><IconAlertCircle aria-hidden /><AlertDescription className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 break-words">{error}</span><Button variant="secondary" onClick={() => { setError(null); void load().catch((e: Error) => setError(e.message)); }}>Try again</Button></AlertDescription></Alert>}
            {!detail && !error ? <div className="file-grid" role="status" aria-label="Loading files">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-video" />)}</div> : detail && !visible.length ? (
              <Empty className="rise py-20">
                <EmptyHeader>
                  <EmptyMedia variant="icon">{query ? <IconSearch aria-hidden /> : view === "libraries" ? <IconLibrary aria-hidden /> : <IconFile aria-hidden />}</EmptyMedia>
                  <EmptyTitle role="heading" aria-level={2}>{query ? "No files match" : view === "libraries" ? "No shared libraries yet" : "Start with a file"}</EmptyTitle>
                  <EmptyDescription>{query ? `Nothing in ${current.name} is called “${query.trim()}”.` : view === "libraries" ? "When a file uses another file’s design system, that file shows up here." : "Create one, then ask your agent to design in it. Everyone in the workspace sees changes live."}</EmptyDescription>
                </EmptyHeader>
                {(query || view === "all") && <EmptyContent>
                  {query ? <Button variant="secondary" onClick={() => setQuery("")}>Clear search</Button> : <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={newFile}><IconPlus aria-hidden />New file</Button>
                    <Button variant="secondary" onClick={(e) => void openAgent(e.currentTarget)} aria-disabled={agentLoading} aria-busy={agentLoading}>{agentLoading ? <Spinner aria-hidden /> : <IconTerminal2 aria-hidden />}Connect an agent</Button>
                  </div>}
                </EmptyContent>}
              </Empty>
            ) : (
              <div className="file-grid">
                {visible.map((file, i) => (
                  <Card key={file.id} size="sm" className="rise min-w-0 gap-0 pt-0" style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                    <Link href={`/f/${file.id}`} className="block outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label={`Open ${file.name}`}>
                      <div className="grid aspect-video place-items-center overflow-hidden bg-muted/30">{file.cover ? <img src={file.cover} alt="" loading="lazy" className="h-full w-full object-contain" /> : <Empty className="gap-1 p-2"><EmptyMedia className="mb-0 text-muted-foreground"><IconLayout2 className="size-4" aria-hidden /></EmptyMedia><EmptyDescription>Empty canvas</EmptyDescription></Empty>}</div>
                    </Link>
                    <CardFooter className="items-start gap-1 pt-3">
                      <div className="min-w-0 flex-1">
                        <CardTitle><Link href={`/f/${file.id}`} className="block truncate" tabIndex={-1} title={file.name}>{file.name}</Link></CardTitle>
                        <CardDescription className="truncate" title={fileMeta(file, names)}>{fileMeta(file, names)}</CardDescription>
                      </div>
                      <FileMenu file={file} onRename={() => void renameFile(file)} onDelete={() => void deleteFile(file)} />
                    </CardFooter>
                  </Card>
                ))}
              </div>
            )}
            </TabsContent>
          </Tabs>
        )}
      </main>
      {AgentSettings && <AgentSettings config={agentConfig} open={agentOpen} onOpenChange={setAgentOpen} />}
    </div>
  );
}

function fileMeta(file: FileSummary, names: Map<string, string>) {
  const parts = [`Edited ${timeAgo(file.updated_at)}`];
  if (file.used_by > 0) parts.unshift(`Library for ${file.used_by} ${file.used_by === 1 ? "file" : "files"}`);
  if (file.library_id) parts.push(`Uses ${names.get(file.library_id) ?? "a library"}`);
  return parts.join(" · ");
}

/** The file's rare actions live behind one quiet button instead of on the card. */
function FileMenu({ file, onRename, onDelete }: { file: FileSummary; onRename: () => void; onDelete: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openAction = (action: () => void) => requestAnimationFrame(() => {
    // The menu item unmounts; make the persistent trigger the modal's focus-return target.
    trigger.current?.focus();
    action();
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} variant="ghost" size="icon" className="-mt-1 -mr-1" aria-label={`More actions for ${file.name}`}><IconDots aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={() => openAction(onRename)}><IconPencil aria-hidden />Rename</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => openAction(onDelete)}><IconTrash aria-hidden />Delete…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
