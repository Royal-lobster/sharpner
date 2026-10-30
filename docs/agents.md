# Connecting an agent

Agents use Sharpner's remote MCP endpoint to create files, arrange sections,
write HTML, define tokens and components, and inspect rendered screenshots.
Open **Connect an agent** in the workspace to copy the command for your deployment.

Copy the command from **Connect an agent**. When a public Claude Code client is configured, it includes the registered client ID and callback port:

```sh
claude mcp add --transport http --client-id <public-client-id> --callback-port 54765 sharpner https://<your-domain>/mcp
```

On first use, Claude Code opens Clerk's browser sign-in/consent flow and receives its result on the registered local callback. The client ID and callback port are public configuration; no client secret or bearer header is needed.

There is no Sharpner OAuth callback or token broker. Clerk handles authorization, PKCE, and token refresh. Other agents need their own registered public OAuth client or a CIMD metadata URL approved in Clerk; the JSON connection snippet alone does not register a client. Automatic client registration is disabled.

Discovery endpoints:

| Path | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | Canonical MCP resource metadata, referenced by the unauthenticated `/mcp` response's `WWW-Authenticate` challenge |
| `/.well-known/oauth-protected-resource` | Alias for the same resource metadata |
| `/.well-known/oauth-authorization-server` | Compatibility discovery forwarded from the configured Clerk issuer |

OAuth scopes (`openid`, `profile`, `email`, and optional `offline_access`) describe identity and refresh access. They are separate from design-tool permissions: Sharpner gives authenticated OAuth agents a fixed read/write ceiling, restricted to their member's current workspaces. OAuth does not bypass membership checks or add administrative permissions.

Agent keys are an optional fallback, hidden by default. Enable the API Keys feature in Clerk separately, then set `CLERK_API_KEYS_ENABLED=1` to show **Connect an agent → Use an agent key instead**. It creates Clerk-managed, user-scoped keys with `sharpner:read` and `sharpner:write` permissions and a 90-day lifetime. Keys are shown once and can be revoked there. Read-only keys cannot mutate designs; organization-scoped keys are rejected because an agent must act as a member. To use a key:

```sh
claude mcp add --transport http sharpner https://<your-domain>/mcp --header "Authorization: Bearer <agent-key>"
```

| Tool | Purpose |
| --- | --- |
| `get_app_state` | Workspaces, files, and the member's current page and selection |
| `read_guide` | Design-system or screen-design guidance |
| `create_file` | Create a workspace file, optionally linked to a library |
| `set_library` | Link or remove a file's workspace library |
| `get_file` | Pages, section bounds, and node geometry, without sources |
| `get_design_system` | Merged token CSS, component tags, props, slots, and definition locations |
| `create_page` / `rename_page` / `delete_page` | Organize pages; deleting a page deletes its nodes |
| `create_section` | Create an auto-fitting section, optionally nested |
| `create_nodes` | Create up to 20 frames, components, token sheets, or images; omitted coordinates auto-place nodes |
| `read_nodes` | Read up to 20 nodes with their HTML or CSS sources |
| `update_nodes` | Update up to 50 nodes or sections, including geometry, source, page, and grouping |
| `edit_node_source` | Ordered find/replace edits, with unique matches unless `all` is set |
| `delete_nodes` | Delete nodes; deleting a section also deletes its contents |
| `upload_image` | Upload from a URL or base64 and return a permanent URL |
| `screenshot_nodes` | Render up to four frames, components, or token sheets; requires Browser Rendering |

## Design workflow

Start with `get_app_state`, open the file with `get_file`, and read its design
system with `get_design_system`. Use `read_guide("design-system")` and
`read_guide("screens")` for the built-in authoring guides.

Create screens inside sections without coordinates to use automatic layout.
Read sources before editing, then inspect screenshots to check the result.
See the [design-system guide](../worker/guides/design-system.md) and
[screen guide](../worker/guides/screens.md) for examples.

## Configure OAuth for your deployment

Register a public OAuth client in Clerk with PKCE. For callback port `54765`,
register both `http://localhost:54765/callback` and
`http://127.0.0.1:54765/callback`. Set `CLERK_MCP_CLIENT_ID` and
`CLERK_MCP_CALLBACK_PORT` in local `.dev.vars` or production Wrangler `vars`.
These are public configuration; the client needs no secret.

Publish Clerk's OAuth server. Other agents need their own registered public
client or an approved Client ID Metadata Document (CIMD). Use pre-registered
clients only and approve CIMD metadata URLs in the Clerk Dashboard. Dynamic
client registration is disabled.
