# Connect this agent to Sharpner

Sharpner is a shared design canvas with a remote MCP server.
Configure the current agent's MCP client. Guide the member through sign-in.

## Discover this deployment

Fetch `/auth/config` from this document's origin. Use `appOrigin` if present.

- Server name: `sharpner`
- Transport: Streamable HTTP
- MCP endpoint: `<origin>/mcp`
- Protected-resource metadata: `<origin>/.well-known/oauth-protected-resource/mcp`
- OAuth issuer: `authorization_servers` in that metadata.
- Public client details: `mcpClientId` and `mcpCallbackPort` from `/auth/config`.

Sharpner requests `openid profile email offline_access`.
Authentication uses authorization code with PKCE and browser consent.
The public client needs no secret. Its registered callbacks are
`http://localhost:<mcpCallbackPort>/callback` and
`http://127.0.0.1:<mcpCallbackPort>/callback`.

## Configure the current client

Identify the client from its tools, CLI help, or official docs.
Use its supported MCP settings. Preserve existing servers.
For a UI you cannot operate, give the member the exact fields to enter.

Use native remote MCP when it supports the registered public client and callback.
Register the server, then start authentication. Registration alone does not sign in.

For Claude Code, pass the public client ID and callback port to `mcp add`.
Then run `claude mcp login sharpner`, or use `/mcp` → `sharpner` → **Authenticate**.

## Fallback for clients that can launch local MCP servers

If native OAuth cannot use the registered callback, use the
[mcp-remote bridge](https://github.com/punkpeye/mcp-remote).
It handles OAuth locally and exposes the remote tools over stdio.
It requires Node.js and `npx`.

Use the client's documented settings format. Replace placeholders with deployment values.
Keep each `args` element as a separate argument.

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

The port and `/callback` path must match the registration.
Do not use the bridge's default `/oauth/callback` path or a random port.

## Complete authentication

Start the client's authentication flow. Let the member sign in and approve access.
Keep credentials in the client's OAuth store. Explain any required reload or restart.

For SSH or headless sessions, use browser handoff or loopback port forwarding.
The browser's localhost might not reach the agent's machine.
If native OAuth and the bridge cannot work, explain the required client or callback support.
The server URL alone does not authorize unknown OAuth clients.

If public client details are null, ask the deployment owner to register a client.
An approved client metadata URL is another option.

## Verify before declaring success

List the server's tools. Call `get_app_state`.
Report accessible workspaces, changed settings, and steps the member must complete.
Saved settings alone do not prove a connection.
Do not create or modify designs during setup.

After setup, call `read_skill()` before design edits. Follow the member's request.
Use explicit file and page IDs when agents work in parallel.
