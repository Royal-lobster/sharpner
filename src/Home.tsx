import { CreateOrganization, OrganizationSwitcher, UserButton, useClerk } from "@clerk/react";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import type { AgentConnectionConfig, Me } from "./App";
import { api, timeAgo, type FileSummary, type Workspace } from "./api";
import { Link, navigate } from "./router";
import { askConfirm, askText, ResponsiveDialog } from "./dialog";
import { toast } from "./toast";
import { IconAlertCircle, IconCheck, IconChevronDown, IconCopy, IconDots, IconFile, IconFolder, IconKey, IconLayout2, IconLibrary, IconPencil, IconPlus, IconSearch, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

type WorkspaceDetail = { workspace: Workspace; files: FileSummary[] };

export function Home({ me, agentConfig }: { me: Me; agentConfig: AgentConnectionConfig }) {
  const clerk = useClerk();
  const current = me.workspaces.find((w) => w.id === me.activeWorkspaceId);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "libraries">("all");
  const [agentOpen, setAgentOpen] = useState(false);
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
    let active = true;
    alive.current = true;
    setDetail(null); setError(null);
    void load().catch((e: Error) => { if (active && e.name !== "AbortError") setError(e.message); });
    return () => { active = false; alive.current = false; sequence.current++; };
  }, [load]);
  useEffect(() => {
    if (me.activeWorkspaceId || !me.workspaces.length) return;
    void clerk.setActive({ organization: me.workspaces[0]!.clerkOrganizationId }).catch((e: Error) => setError(e.message));
  }, [clerk, me.activeWorkspaceId, me.workspaces]);

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
            <Button variant="ghost" onClick={() => setAgentOpen(true)} aria-label="Connect an agent" title="Connect an agent">
              <IconTerminal2 aria-hidden /><span className="hidden sm:inline">Connect agent</span>
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
                    <Button variant="secondary" onClick={() => setAgentOpen(true)}><IconTerminal2 aria-hidden />Connect an agent</Button>
                  </div>}
                </EmptyContent>}
              </Empty>
            ) : (
              <div className="file-grid">
                {visible.map((file, i) => (
                  <Card key={file.id} size="sm" className="rise min-w-0 gap-0 pt-0" style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                    <Link href={`/f/${file.id}`} className="block outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-label={`Open ${file.name}`}>
                      <div className="grid aspect-video place-items-center overflow-hidden bg-muted/30">{file.cover ? <img src={file.cover} alt="" loading="lazy" className="h-full w-full object-contain p-3" /> : <Empty className="gap-1 p-2"><EmptyMedia className="mb-0 text-muted-foreground"><IconLayout2 className="size-4" aria-hidden /></EmptyMedia><EmptyDescription>Empty canvas</EmptyDescription></Empty>}</div>
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
      <AgentSettings config={agentConfig} open={agentOpen} onOpenChange={setAgentOpen} />
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

function AgentSettings({ config, open, onOpenChange }: { config: AgentConnectionConfig; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [keysOpen, setKeysOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const url = `${location.origin}/mcp`;
  const guideUrl = `${location.origin}/agent-setup.md`;
  const prompt = [
    "Connect this agent to Sharpner.",
    "",
    `Setup guide: ${guideUrl}`,
    `MCP endpoint: ${url}`,
    "",
    "1. Read the setup guide and identify the MCP host/client in this environment. Use its supported setup mechanism and preserve existing MCP server settings.",
    "2. Configure Sharpner using the guide's native connection or local bridge instructions, whichever this client supports.",
    "3. Start authentication separately. Guide me through any browser sign-in, consent, restart, or client UI steps that you cannot complete yourself.",
    "4. Verify the connection by listing its tools and calling get_app_state. Report which workspaces are accessible.",
    "5. If this environment cannot complete setup, explain the exact missing capability and the next step for me. Do not claim success until verified, and do not create or edit designs during setup.",
  ].join("\n");
  const clientFlags = config.mcpClientId && config.mcpCallbackPort ? ` --client-id ${config.mcpClientId} --callback-port ${config.mcpCallbackPort}` : "";
  const cli = `claude mcp add --transport http${clientFlags} sharpner ${url}`;
  const bridge = config.mcpClientId && config.mcpCallbackPort ? {
    command: "npx",
    args: ["-y", "mcp-remote@0.15.2", url, String(config.mcpCallbackPort), "--callback-path", "/callback",
      "--static-oauth-client-info", JSON.stringify({ client_id: config.mcpClientId }), "--transport", "http-only"],
  } : null;
  const json = JSON.stringify({ mcpServers: { sharpner: bridge ?? { type: "http", url } } }, null, 2);
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Connect an agent"
      description="Design with your agent and watch its changes appear live." className="agent-dialog sm:max-w-[500px]">
      <div className="flex min-w-0 flex-col gap-4">
        <Tabs defaultValue="agent" className="min-w-0 gap-4">
          <TabsList className="w-full" aria-label="Connection setup">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="manual">Manual setup</TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Let your agent connect</h3>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">Paste this prompt into your coding agent. It can set up the connection and guide you through sign-in.</p>
            </div>
            <CopyButton text={prompt} label="Copy setup prompt" variant="default" size="lg" className="w-full" />
            <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
              <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between">{promptOpen ? "Hide prompt" : "Show prompt"}<IconChevronDown className={promptOpen ? "rotate-180" : undefined} aria-hidden /></Button></CollapsibleTrigger>
              <CollapsibleContent className="pt-2"><pre className="m-0 max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{prompt}</pre></CollapsibleContent>
            </Collapsible>
          </TabsContent>
          <TabsContent value="manual" className="flex min-w-0 flex-col gap-3">
            <CopyBlock label="MCP endpoint" text={url} />
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">Use Streamable HTTP and sign in with OAuth through your client’s connection settings. The <a href={guideUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">setup guide</a> covers native connections and a local bridge.</p>
            <Collapsible className="border-t pt-2">
              <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between">Claude Code commands<IconChevronDown aria-hidden /></Button></CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <ItemGroup>
                  <Item role="listitem" className="items-start p-0">
                    <ItemMedia><Badge variant="outline" aria-label="Step 1">1</Badge></ItemMedia>
                    <ItemContent className="min-w-0 gap-2"><ItemTitle>Add Sharpner</ItemTitle><ItemDescription>This saves the connection. Sign in separately in the next step.</ItemDescription><CopyBlock label="Terminal" text={cli} /></ItemContent>
                  </Item>
                  <Item role="listitem" className="items-start p-0">
                    <ItemMedia><Badge variant="outline" aria-label="Step 2">2</Badge></ItemMedia>
                    <ItemContent className="min-w-0 gap-2"><ItemTitle>Start authentication</ItemTitle><ItemDescription>Run this in the same project directory.</ItemDescription><CopyBlock label="Terminal" text="claude mcp login sharpner" /><ItemDescription>Inside Claude Code, you can also use <code>/mcp</code> → <strong>sharpner</strong> → <strong>Authenticate</strong>.</ItemDescription></ItemContent>
                  </Item>
                  <Item role="listitem" className="items-start p-0">
                    <ItemMedia><Badge variant="outline" aria-label="Step 3">3</Badge></ItemMedia>
                    <ItemContent className="min-w-0"><ItemTitle>Approve access in your browser</ItemTitle><ItemDescription>Sign in to Sharpner and approve your agent’s access to your workspace files.</ItemDescription></ItemContent>
                  </Item>
                </ItemGroup>
              </CollapsibleContent>
            </Collapsible>
            <Collapsible className="border-t pt-2">
              <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between">{bridge ? "Local MCP bridge" : "JSON configuration"}<IconChevronDown aria-hidden /></Button></CollapsibleTrigger>
              <CollapsibleContent className="flex min-w-0 flex-col gap-3 pt-3"><p className="text-xs leading-relaxed text-muted-foreground">{bridge ? "For clients that can run local MCP servers. Requires Node.js and opens browser sign-in. Adapt this JSON to your client’s configuration format." : "Example for clients that read mcpServers JSON. Authentication also needs a compatible OAuth client and callback."}</p><CopyBlock label="mcp.json" text={json} pre /></CollapsibleContent>
            </Collapsible>
          </TabsContent>
        </Tabs>
        {config.agentKeysEnabled && <Collapsible open={keysOpen} onOpenChange={setKeysOpen} className="border-t pt-2">
          <CollapsibleTrigger asChild><Button variant="ghost" className="w-full justify-between">Use an agent key instead<IconChevronDown aria-hidden /></Button></CollapsibleTrigger>
          <CollapsibleContent className="pt-3">{keysOpen && <AgentKeys />}</CollapsibleContent>
        </Collapsible>}
      </div>
    </ResponsiveDialog>
  );
}

function CopyBlock({ label, text, pre }: { label: string; text: string; pre?: boolean }) {
  return (
    <Card size="sm" className="min-w-0 gap-2">
      <CardHeader className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{label}</span><CopyButton text={text} /></CardHeader>
      <CardContent>{pre ? <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</pre> : <code className="block select-all whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</code>}</CardContent>
    </Card>
  );
}

function CopyButton({ text, label = "Copy", variant = "ghost", size = "sm", className }: {
  text: string; label?: string;
} & Pick<ComponentProps<typeof Button>, "variant" | "size" | "className">) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <Button type="button" variant={variant} size={size} className={className} aria-live="polite" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1400); }
    catch { toast("Could not copy. Select the text to copy it manually.", { tone: "error" }); }
  }}>{copied ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}<span>{copied ? "Copied" : label}</span></Button>;
}

type AgentKey = { id: string; name: string; created_at: number; last_used_at: number | null; expiration?: number | null; scopes?: string[] };

function AgentKeys() {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState("My agent");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const load = async () => { const data = await api<AgentKey[]>("/keys"); if (alive.current) setKeys(data); };
  useEffect(() => { alive.current = true; void load().catch((e: Error) => { if (alive.current) setError(e.message); }).finally(() => { if (alive.current) setLoading(false); }); return () => { alive.current = false; }; }, []);
  const cli = `claude mcp add --transport http sharpner ${location.origin}/mcp --header "Authorization: Bearer ${fresh ?? "<agent key>"}"`;
  return <section className="flex min-w-0 flex-col gap-4">
    <p className="text-xs/relaxed text-muted-foreground">Keys act as you and expire after 90 days. Keep them private.</p>
    {error && <Alert variant="destructive"><IconAlertCircle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
    <form onSubmit={async (e) => {
      e.preventDefault(); if (!name.trim() || busy) return; setBusy(true); setError(null);
      try { const result = await api<{ key: string }>("/keys", { method: "POST", json: { name: name.trim() } }); if (!alive.current) return; setFresh(result.key); await load(); }
      catch (e) { if (alive.current) setError((e as Error).message); }
      finally { if (alive.current) setBusy(false); }
    }}><Field><FieldLabel htmlFor="agent-key-name">Agent key name</FieldLabel><div className="flex items-center gap-2"><Input id="agent-key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /><Button variant="secondary" disabled={busy}>{busy && <Spinner aria-hidden />}{busy ? "Creating…" : "Create key"}</Button></div></Field></form>
    {fresh && <><Alert><IconKey aria-hidden /><AlertTitle>Save this key now</AlertTitle><AlertDescription>It won’t be shown again.</AlertDescription></Alert><CopyBlock label="Claude Code with key" text={cli} /></>}
    {loading ? <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Spinner aria-hidden />Loading agent keys…</div> : keys.length > 0 ? <ItemGroup>{keys.map((key) => <Item key={key.id} role="listitem" variant="outline" size="xs"><ItemContent className="min-w-0"><ItemTitle>{key.name}</ItemTitle><ItemDescription>{key.last_used_at ? `Used ${timeAgo(key.last_used_at)}` : "Never used"}</ItemDescription></ItemContent><ItemActions><Button variant="destructive" size="sm" onClick={async () => {
      if (!await askConfirm({ title: `Revoke “${key.name}”?`, message: "Agents using this key lose access immediately.", confirm: "Revoke key", danger: true })) return;
      try { await api(`/keys/${key.id}`, { method: "DELETE" }); await load(); }
      catch (e) { if (alive.current) setError((e as Error).message); }
    }}>Revoke</Button></ItemActions></Item>)}</ItemGroup> : !error && <Empty className="py-6"><EmptyHeader><EmptyMedia variant="icon"><IconKey aria-hidden /></EmptyMedia><EmptyTitle>No agent keys</EmptyTitle><EmptyDescription>Create one above to connect an agent with a key.</EmptyDescription></EmptyHeader></Empty>}
  </section>;
}
