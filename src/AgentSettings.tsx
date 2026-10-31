import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { AgentConnectionConfig } from "./App";
import { api, timeAgo } from "./api";
import { askConfirm } from "./dialog";
import { ResponsiveDialog } from "./dialog-runtime";
import { toast } from "./toast";
import { IconAlertCircle, IconCheck, IconChevronDown, IconCopy, IconKey } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

export function AgentSettings({ config, open, onOpenChange }: { config: AgentConnectionConfig; open: boolean; onOpenChange: (open: boolean) => void }) {
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
