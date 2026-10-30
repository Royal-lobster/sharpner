# Connect this agent to Sharpner

Sharpner is a shared design canvas with a remote MCP server. Configure the MCP
client you are actually running in, then guide the human through sign-in.
There is no Sharpner CLI to install.

## Discover this deployment

Use the origin of this document as the deployment origin. Fetch its public
`/auth/config`. If `appOrigin` is present, use that canonical origin instead.

- Server name: `sharpner`
- Transport: Streamable HTTP
- MCP endpoint: `<origin>/mcp`
- Protected-resource metadata: `<origin>/.well-known/oauth-protected-resource/mcp`
- OAuth issuer: discover it from `authorization_servers` in that metadata.
- Public client details: `mcpClientId` and `mcpCallbackPort` from `/auth/config`.

Sharpner requests `openid profile email offline_access`. Authentication uses
authorization code with PKCE and browser consent. The public client needs no
client secret. Its registered callbacks are
`http://localhost:<mcpCallbackPort>/callback` and
`http://127.0.0.1:<mcpCallbackPort>/callback`.

## Configure the current client

Identify the host from its available tools, local CLI help, or official docs.
Use its supported MCP settings or configuration format. Preserve existing
servers. If settings are managed through a UI you cannot operate, give the
human the exact fields to enter rather than writing an unused config file.

Prefer native remote MCP when the client supports a registered public OAuth
client ID and one of the callbacks above. Registration and authentication are
separate steps. Adding a server does not necessarily start sign-in.

For Claude Code, use its documented `mcp add` flags for the public client ID and
callback port, then `claude mcp login sharpner`. Inside Claude Code,
`/mcp` → `sharpner` → **Authenticate** is another way to start sign-in.

## Fallback for clients that can launch local MCP servers

When native OAuth cannot use the registered callback, use the
[mcp-remote bridge](https://github.com/punkpeye/mcp-remote). It handles OAuth
locally and exposes the same remote tools over stdio. It requires Node.js and
`npx`; it does not add a dependency to Sharpner itself.

Adapt this server entry to the host's documented JSON, TOML, or settings format.
Replace every placeholder with the discovered deployment values. Each `args`
element must remain a separate argument.

```json
{
  "mcpServers": {
    "sharpner": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.15.2",
        "<origin>/mcp",
        "<mcpCallbackPort>",
        "--callback-path",
        "/callback",
        "--static-oauth-client-info",
        "{\"client_id\":\"<mcpClientId>\"}",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

The explicit port and `/callback` path must both match the registration.
Do not use the bridge's default `/oauth/callback` path or a random port.

## Complete authentication

Start authentication with the client's supported mechanism. Let the human
complete browser sign-in and approve access; keep credentials in the client's
normal OAuth store. Explain any reload or restart needed before tools appear.

For SSH or headless environments, use the client's documented browser handoff
or loopback port forwarding. Do not assume a browser's localhost reaches the
agent's machine. If the host supports neither compatible native OAuth nor a
local bridge, explain the exact client-registration or callback support needed.
This deployment does not automatically admit unknown OAuth clients; a bare
server URL does not bypass that requirement.

If the public client details are null, the deployment owner must configure a
registered client first. An approved client metadata URL is another option.

## Verify before declaring success

List the connected server's tools and call `get_app_state`. Report the
accessible workspaces, the configuration changed, and whether the human must
still complete any step. Do not claim success based only on saving settings.
Do not create or modify designs during setup.

After setup, follow the human's design request. Use explicit file and page IDs
when several agents work in parallel. Read the file and its design system
before editing, and inspect rendered results with the screenshot tools.
