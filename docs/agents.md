# Connecting an agent

Agents use Sharpner's remote MCP endpoint to create files, arrange sections,
write HTML, define tokens and components, and inspect rendered screenshots.
Open **Connect an agent → Agent** in the workspace and copy the setup prompt
into your coding agent. It identifies its own MCP host, configures the server,
guides you through browser sign-in, and verifies access with `get_app_state`.
The deployment serves a public [agent setup guide](../public/agent-setup.md) at
`/agent-setup.md`; it reads public connection details from `/auth/config`, so
self-hosted instances do not need a hard-coded client ID in the guide.

The guide prefers compatible native OAuth and offers an `mcp-remote` stdio
bridge for clients that can launch local MCP servers. Clients with neither
capability still need a compatible OAuth registration. **Manual setup** keeps
the endpoint and client-specific instructions available.

For manual Claude Code setup, copy the command from **Connect an agent →
Manual setup → Claude Code commands**. When a public client is configured,
the command includes its registered client ID and callback port:

```sh
claude mcp add --transport http --client-id <public-client-id> --callback-port 54765 sharpner https://<your-domain>/mcp
```

The add command saves the connection; it does not sign you in. Authenticate it
separately from the same project directory:

```sh
claude mcp login sharpner
```

Alternatively, open or restart Claude Code, run `/mcp`, select **sharpner**, and
choose **Authenticate**. Complete Clerk's browser sign-in and approve access.
Claude Code receives the result on the registered local callback and stores the
credentials for later sessions. If Sharpner is already registered, skip the add
command and retry authentication directly.

For SSH or headless terminals, use `claude mcp login sharpner --no-browser` and
follow its authorization URL and callback prompts. See [Claude Code's MCP
authentication guide](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line).

The client ID and callback port are public configuration; no client secret or
bearer header is needed.

There is no Sharpner OAuth callback or token broker. Clerk handles authorization,
PKCE, and token refresh. Native clients can use a compatible registered public
client or a CIMD metadata URL approved in Clerk; the JSON connection snippet
alone does not register a client. Automatic client registration is disabled.
The local bridge uses the existing public client with its fixed loopback port
and `/callback` path.

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
| `get_app_state` | Workspaces, files, and the member's current page, selection, and the open file's page descriptions |
| `list_comments` | Open feedback by default; filter by file page, node, or resolution state, with pagination and excerpts |
| `get_comment_thread` | Full feedback text, replies, authors, anchor, and resolution state |
| `add_comment` | Pin a new comment to a node or page coordinate |
| `reply_to_comment` | Add a visibly attributed agent reply |
| `resolve_comment` | Resolve addressed feedback, or reopen it with `resolved: false` |
| `read_guide` | Design-system or screen-design guidance |
| `create_file` | Create a workspace file, optionally linked to a library |
| `set_library` | Link or remove a file's workspace library |
| `list_pages` | A file's table of contents: page and section descriptions with design counts |
| `get_file` | Pages, section bounds, and node geometry, without sources; `pageId` limits it to one page |
| `get_design_system` | Merged token CSS, component tags, props, slots, and definition locations |
| `create_page` / `update_page` / `delete_page` | Organize and describe pages; deleting a page deletes its nodes |
| `create_section` | Create an auto-fitting, described section, optionally nested |
| `create_nodes` | Create up to 20 frames, components, token sheets, or images; omitted coordinates auto-place nodes |
| `read_nodes` | Read up to 20 nodes with their HTML or CSS sources |
| `update_nodes` | Update up to 50 nodes or sections, including geometry, source, page, and grouping |
| `edit_node_source` | Ordered find/replace edits, with unique matches unless `all` is set |
| `delete_nodes` | Delete nodes; deleting a section also deletes its contents |
| `upload_image` | Upload from a URL or base64 and return a permanent URL |
| `screenshot_nodes` | Render up to four frames, components, or token sheets; requires Browser Rendering |

## Design workflow

Start with `get_app_state`, find your way with `list_pages`, open the page you
need with `get_file({ fileId, pageId })`, and read the design system with
`get_design_system`. Pages and sections carry short descriptions, like skill
descriptions: what they hold and when to look at them. Agents write one for
each page and section they create; members can edit page descriptions from the
Pages panel. Use `read_guide("design-system")` and
`read_guide("screens")` for the built-in authoring guides.

Create screens inside sections without coordinates to use automatic layout.
Read sources before editing, then inspect screenshots to check the result.
See the [design-system guide](../worker/guides/design-system.md) and
[screen guide](../worker/guides/screens.md) for examples.

## Addressing feedback

Members press **C**, then click or tap a spot on the canvas to leave a comment.
The comments button in the bottom dock opens threads across the file, with
separate open/resolved lists. Pins follow their designs through layout and page
changes. Deleting a design leaves its feedback at its last position; deleting a
page removes its threads. Comments and active-member identities are private to
workspace members and are excluded from public view links.

When the member asks to "fix the comments":

1. Use `get_app_state` to find the file and its open-comment count.
2. Call `list_comments({ fileId })`. Follow `nextOffset` until it is `null`;
   `pageId`, `nodeId`, and `status` (`open`, `resolved`, `all`) narrow the list.
3. Call `get_comment_thread({ fileId, threadId })` for each relevant thread.
   List excerpts can be truncated; read the full feedback and replies before editing.
4. Inspect the anchor's `nodeId` with `read_nodes` and `screenshot_nodes`, make
   the requested edits, and verify the result. A null `nodeId` means feedback
   on the page; use the anchor coordinates and surrounding designs for context.
5. Explain the change with `reply_to_comment({ fileId, threadId, body })`, then
   `resolve_comment({ fileId, threadId, resolved: true })`. Ask for clarification
   in a reply when needed and leave that thread open.

Comments do not automatically start agent work. A member must ask the agent to
address them. Agent replies and resolutions retain their agent attribution;
resolving feedback preserves the conversation and does not itself edit a design.
Reading requires `sharpner:read`; posting, replying, and resolving require
`sharpner:write`, always within the member's current workspace access.

## Configure OAuth for your deployment

Register a public OAuth client in Clerk with PKCE. For callback port `54765`,
register both `http://localhost:54765/callback` and
`http://127.0.0.1:54765/callback`. Set `CLERK_MCP_CLIENT_ID` and
`CLERK_MCP_CALLBACK_PORT` in local `.dev.vars` or production Wrangler `vars`.
These are public configuration; the client needs no secret.

The registered client must allow every scope Sharpner requests: `openid`,
`profile`, `email`, and `offline_access`. Setting instance-wide default scopes
does not grant those scopes to an existing client. A missing client scope
causes an `invalid_scope` callback error; correct the allowed scopes in Clerk,
then start authentication again.

Publish Clerk's OAuth server. Other agents need their own registered public
client or an approved Client ID Metadata Document (CIMD). Use pre-registered
clients only and approve CIMD metadata URLs in the Clerk Dashboard. Dynamic
client registration is disabled.
