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
| `read_skill` | Read SKILL.md, or a referenced file by path |
| `create_file` | Create a workspace file, optionally linked to a library |
| `set_library` | Link or remove a file's workspace library |
| `set_cover` | Pin a frame or image as the workspace card cover; pass `nodeId: null` to restore automatic selection |
| `set_theme` | Set the file theme inherited by screens; null preserves authored theme contexts. Frames can override with their `theme` field |
| `list_pages` | A file's table of contents: page and section descriptions with design counts, and whether each page tiles or stacks (and why) |
| `get_file` | Cover choice, pages, section bounds, and node geometry, without sources; `pageId` limits it to one page |
| `get_design_system` | Brand, Design System page ID, merged token CSS, component tags, props, slots, primitive status, locations, overrides and use counts, including the library |
| `set_brand` | Patch this file’s name, image logoUrl, guidelines paragraph or voice bullets; omitted fields stay unchanged |
| `find_instances` | Frames and components using a component, here and in files using this one as a library |
| `create_page` / `update_page` / `delete_page` | Organize and describe pages; `kind: "design-system"` chooses the file’s single document page, `kind: "canvas"` restores canvas. Conversion preserves nodes; deletion removes them |
| `create_section` | Create an auto-fitting, described section, optionally nested |
| `create_nodes` | Create up to 20 frames, components, token sheets, or images; omitted coordinates auto-place nodes |
| `read_nodes` | Read up to 20 nodes with their HTML or CSS sources |
| `update_nodes` | Update up to 50 nodes or sections, including geometry, source, page, and grouping; a loose node moved to another page without x/y lands right of its content |
| `edit_node_source` | Ordered find/replace edits, with unique matches unless `all` is set |
| `delete_nodes` | Delete nodes; deleting a section also deletes its contents |
| `upload_image` | Upload from a URL or base64 and return a permanent URL |
| `report_friction` | Complaint box: report friction in Sharpner's own tools, or add to a known issue with `sameAs` |
| `list_friction` | The biggest known agent-experience flaws, weighted by severity across reports; `issueId` reads one issue |
| `screenshot_nodes` | Render up to four frames, components, or token sheets; requires Browser Rendering |

## Design workflow

Call `read_skill()` before edits. It returns the [Sharpner skill](../worker/skills/sharpner/SKILL.md).
Then read only the references needed for the task:

```js
read_skill() // SKILL.md
read_skill({ path: "references/design-system.md" })
read_skill({ path: "references/screens.md" })
```

The skill uses `get_app_state` to find the member's file and selection.
Use `list_pages` for navigation, `get_file({ fileId, pageId })` for a page,
and `read_nodes` for sources. Describe new pages and sections so later agents
can find the work. Members can edit page descriptions in the Pages panel.

Startup instructions identify the service and skill tool. Clients control when
tool definitions enter context. Discovery tests limit startup text to 400
characters, each tool description to 300 characters, and the full catalog to
17,500 UTF-8 bytes, including screenshots. These are size budgets, not token counts.

Choose the Design System document with `create_page` or `update_page` and `kind: "design-system"`. It always shows Brand, generated Foundations and generated Primitive components, with a preview theme switcher. `set_brand({ fileId, name, logoUrl, guidelines, voice })` patches the file’s only authored section; upload a logo image with `upload_image`. Create primitive components with `create_nodes` on that page: placement registers them. CSS comments describe token rows; undeclared tokens have no rows. Recommended shadcn/ui families and color slots lead the generated lists, including aliases such as Radio and Tab. Theme overrides appear next to defaults, and families over six variants collapse.

A linked library’s Brand, Foundations and primitives appear on the same page read-only, labeled **From library: <name> · Open**; edit inherited definitions there. Local additions are marked **This file**; token overrides retain the original library rows, and local tag definitions replace the library’s definitions. The library exports its own catalog only. Conversion keeps nodes, with other designs listed compactly for moving. The document has no canvas, side panel, per-row comments or phone tabs. Existing editor comments remain available.

Keep the Design System page to brand guidelines, foundations and primitives. Give each sizable feature a page with its screens, states, and reused feature components; use feature-prefixed component names because tags remain file-wide. Add primitives as needed rather than prebuilding application component catalogs.

Use `set_theme` for the file default and a frame's `theme` field in `create_nodes` or `update_nodes` for an override (`null` restores inheritance). `get_design_system` reports theme names from the token CSS; `get_file` and `read_nodes` report each frame's choice and effective theme. Members choose the file theme in the navigation dock and a selected screen's theme in the selection bar. With no file choice, As authored preserves existing HTML theme contexts. Compare themes in neighboring frames with explicit theme overrides so a file change keeps the comparison intact. Token overrides handle colors, fonts, radii, and shadows; feature components can carry scoped decoration CSS. When a theme needs different component structure, create a component with the same name and a `theme`: instances inside that theme use that definition, and `get_design_system` lists it under `themeOverrides`. A shared screen component is optional, and substantial structural alternatives can use separate frames.

Finish a new product file with a designed 1600 × 900 HTML frame on a described
Cover page. Use the file's identity and design system, keep its name readable at
thumbnail size, inspect it with `screenshot_nodes`, then pin it with
`set_cover({ fileId, nodeId })`. `get_file` reports `cover: { nodeId, url }`;
`nodeId: null` means automatic selection. Maintain an established cover in place,
respect member choices, and update it when the product's identity changes.
The saved choice follows edits and preview regeneration; deleting its node,
section or page restores automatic selection. Pass `nodeId: null` to reset it
explicitly. The screen guide includes cover composition guidance.

Members can select a frame or image and choose **Use as file cover** in the selection bar.
**File → Use automatic cover** clears that choice.

Create screens inside sections without coordinates to use automatic layout.
Read sources before editing, then inspect screenshots to check the result.
See the [design-system reference](../worker/skills/sharpner/references/design-system.md) and
[screen reference](../worker/skills/sharpner/references/screens.md) for examples.

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

## Agent experience feedback

Agents file friction in Sharpner's own tools with `report_friction`: confusing
results, missing capabilities, output too large to use, or workarounds they had
to invent. A report that repeats a known issue passes its id as `sameAs`, so
`list_friction` ranks issues by the summed weight of their reports (blocker 5,
major 3, minor 1) instead of collecting duplicates. Read-only connections can
report too; reporting changes no designs.

Reports about a file are visible to members of its workspace; reports without
a file are visible only to their reporter. Deleting a workspace deletes its
reports. To review every report across workspaces, query D1 directly:

```sh
wrangler d1 execute sharpner --remote --command "
  SELECT coalesce(same_as, id) AS issue, MAX(summary) FILTER (WHERE same_as IS NULL) AS summary,
    COUNT(*) AS reports, SUM(CASE severity WHEN 'blocker' THEN 5 WHEN 'major' THEN 3 ELSE 1 END) AS weight
  FROM agent_friction GROUP BY issue ORDER BY weight DESC LIMIT 20"
```

