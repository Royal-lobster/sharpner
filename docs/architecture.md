# Architecture

Sharpner runs as one Cloudflare Worker. The browser, REST routes, and MCP tools
share a file model; each file has one SQLite-backed Durable Object to serialize
edits and fan out changes.

## Finding your way around

| Module | Responsibility |
| --- | --- |
| `src/App.tsx` | Clerk sign-in, routing, and workspace bootstrap |
| `src/Home.tsx` | Workspace file grid, search, and agent connection |
| `src/Editor.tsx` | File lifecycle, page organization, sharing, and presence |
| `src/Comments.tsx` | Canvas feedback list, thread conversations, and comment composition |
| `src/presence.ts` | Active member grouping across tabs and pages |
| `src/Canvas.tsx` | Camera, gestures, selection, and canvas composition |
| `src/canvas-render-plan.ts` | Viewport culling, preview layers, and live-content budgets |
| `src/canvas-navigation.ts` | Content bounds, fitted overview, and camera constraints |
| `src/room.ts` | Realtime client, optimistic edits, and demand-loaded sources |
| `src/thumbnail-cache.ts` | Bounded image loading and decoded-pixel budget |
| `src/touch-gestures.ts` | Touch navigation state machine |
| `src/components/ui/` | shadcn/ui primitives |
| `worker/index.ts` | HTTP routes and authenticated browser entry points |
| `worker/auth.ts` | Clerk verification and session/machine permission checks |
| `worker/accounts.ts` | Clerk identity projections and webhook reconciliation |
| `worker/data.ts` | Workspace-scoped D1 queries and file operations |
| `worker/room.ts` | Per-file persistence, realtime sync, and preview queue |
| `worker/comments.ts` | Transactional SQLite comment storage and anchor lifecycle |
| `worker/mcp.ts` | Agent tools and input validation |
| `worker/render.ts` | Browser Rendering and screenshot helpers |
| `shared/types.ts` | Wire messages, documents, and design-system composition |
| `shared/comments.ts` | Comment input limits and node-relative pin coordinates |
| `shared/layout.ts` | Section geometry shared by canvas, tools, and screenshots |
| `shared/specimens.ts` | Component and token-sheet presentations |

Read [CONTEXT.md](../CONTEXT.md) for the vocabulary before changing the file model.
A workspace controls membership; a file contains pages; a page contains nodes.

## Design systems and libraries

For an app or website, agents can create a **Design System** page for token sheets and components, then build screens on other pages. This is a convention, not a requirement: one-off files can use their default page.

- **Token sheets** (`kind: "tokens"`) contain Tailwind v4 CSS. For example, `@theme { --color-primary: #4f46e5; }` makes `bg-primary` available in every frame. Token sheets render as visual specimens. Add `.dark` overrides for alternate values and opt into that theme on a frame's root. Web-font `@import url(...)` declarations become stylesheet links.
- **Components** (`kind: "component"`) contain reusable HTML. The name sets the tag: `Button/Primary` becomes `<x-button-primary>`. `{{label|Continue}}` takes an instance's `label` attribute or its default; `<slot></slot>` takes the instance's children. Components can compose other components.
- **Libraries** are ordinary files. A file can use one library from its own workspace, selected in file options or with `set_library`. The library contributes its own token sheets and components; the consuming file's definitions take precedence. Library edits update dependent files and regenerate affected thumbnails. Libraries do not re-export their own linked libraries.

```html
<x-card title="Assets">
  <x-list-row title="USDC" meta="Ethereum" value="1,204.50"></x-list-row>
</x-card>
<x-button-primary label="Add money"></x-button-primary>
```

Components use light-DOM custom elements so Tailwind works inside them. Editing a component updates frames that use it, including through other components. Renaming it changes its tag, so its instances must also be updated. Instances support props and slots rather than arbitrary overrides of inner elements.

Agents start with `get_design_system` and `read_guide("design-system")`, reuse existing definitions, then inspect screenshots before building screens. See the [design-system guide](../worker/guides/design-system.md), [screen guide](../worker/guides/screens.md), and [architecture decision](adr/0001-html-native-design-system.md).

## Rendering and loading

Only visible nodes, plus a margin, are considered. Rendering switches with on-screen size:

| On-screen width | Rendered as |
| --- | --- |
| Up to about 280 device px, including tiny nodes | Lazy 256px WebP thumbnail on the canvas |
| Larger | DOM node with a 1280px thumbnail |
| At least 360 CSS px, among the six largest, camera at rest | Live sandboxed iframe with source fetched on demand |

Components can become live from 220 CSS px wide; screen previews use the thresholds above. Without thumbnails, up to twelve nodes can become live from 140 CSS px wide. The low-resolution cache admits a stable viewport working set, capped at 600 images, 16 million decoded pixels, and eight concurrent loads. Dense views beyond that budget use boxes until navigation makes room; they do not continuously evict and reload each other. Original image uploads are promoted only for up to eight large, actually visible images.

Visible frames, components, and token sheets can sharpen on the canvas before reaching the DOM threshold. Once the small preview is ready and the camera stops, nodes at least 64 device pixels wide can load their 1280px preview through a separate queue capped at 32 entries, 32 million decoded pixels, and two concurrent requests. The small preview stays visible until the sharper one is ready. Data Saver and limited connection hints disable this optional work; browsers without those hints use the bounded queue. These upgrades fetch neither live sources nor original image uploads, and cached sharp previews remain visible during navigation.

Initial sync sends geometry, with HTML fetched only for live nodes and the file's design-system definitions. The reusable screen-source cache is limited to 128 entries / 8 MiB of UTF-16 text; the current live working set and required design definitions remain pinned. Matching source revisions survive reconnects. Source requests have backpressure, and responses stream in byte-bounded batches. Direct file loads obtain the verified author with file metadata and skip the separate account bootstrap request; current Clerk user and membership reads run concurrently without caching authorization.

The file's Durable Object debounces thumbnail work, renders 24 nodes per batch across four browser tabs, and retries failures up to three times. Thumbnails use immutable R2 URLs. Agent-created images without a supplied preview enter this same queue, producing a preview up to 400px wide / 1600px tall while retaining the original for close viewing. Browser uploads can supply their own preview. Without Browser Rendering, unpreviewed images use boxes at low zoom and the original at close zoom.

Component nodes show their real default instance directly on the file's background, with a quiet caption for the tag, prop defaults, and slot support. Automatic specimens fit their content; short fixed-height legacy nodes keep a compact preview. Token sheets show a responsive catalog on the same surface, including resolved values for declared light/dark themes. Agents group related variants using ordinary sections. The shared layout function supplies geometry to the canvas, screenshots, and agent tools.

Known limitations: the initial sync still includes geometry for the whole file, including other pages; HTML and image loading are lazy. Canvas-layer nodes paint beneath DOM-layer nodes, so overlapping nodes of very different on-screen sizes can stack incorrectly. Zoomed-out edits appear after the replacement thumbnail is ready. Generating new previews is separate from opening an existing file with previews ready.

Touch navigation uses one finger to pan, two to pinch, and a double-tap to fit a design. Native non-passive touch and Safari gesture handlers keep canvas gestures from becoming page gestures, including when a finger leaves the surface. The editor contains document overscroll; workspace pages and menu scrolling retain their browser behavior. Navbar marks use a tightly framed transparent SVG, separate from the tile used for the favicon and Clerk branding.

Preview navigation stays within the current page's computed content bounds,
with margins for labels and controls. The fitted overview is the minimum zoom
(capped at 100% for small designs); a cluster that fits on an axis stays centered
there. Zoomed-in views can pan between the content's edges. All camera writes,
including mouse/trackpad, touch, keyboard, animated focus and restored views,
use the same constraints. Bounds update with live layout and viewport changes;
visible comment pins also contribute so detached feedback remains reachable.
Empty pages use a bounded 800×600 area until content arrives. Page changes cancel
pending camera animation and persistence work.

## Identity and access

The bottom dock displays a compact avatar stack for connected members, grouped
by member across tabs. Its people list shows their open pages. Disconnecting
clears stale peers until the socket reconnects; agent edit activity is separate.
Presence messages supply geometry only and cannot override verified identities.

Comments live in the file's SQLite Durable Object. Initial sync sends thread
summaries and pin metadata; full messages load only when opening a thread.
Authenticated HTTP routes and MCP tools write through the same transactional
room methods, then broadcast versioned summaries to members. Late HTTP responses
cannot undo newer realtime state or resurrect deleted threads. Node-relative
anchors follow computed layout; node deletion detaches feedback at its previous
position, and page deletion removes its threads. Comment writes do not invalidate
sources, layout caches, thumbnails, or design libraries. Public viewers receive
neither comment summaries nor conversations.

The comment panel reserves canvas space on desktop and mobile, so camera bounds
and focused pins use the visible preview area. Closing the panel or switching
threads preserves unfinished text during the editor session; closing also returns
keyboard focus to the comments control.

Clerk Users identify people; Clerk Organizations are workspaces. Personal Accounts are disabled. The browser uses Clerk sign-in, the organization switcher, and the account menu. Workspace membership and invitations are managed in Clerk rather than separate Sharpner forms.

Sharpner verifies credentials against its configured Clerk instance, then reconciles the person's current memberships before each authenticated HTTP request. D1 preserves stable local author/workspace IDs linked to immutable Clerk IDs; supported roles are `org:admin` → owner and `org:member` → member. Signed Clerk webhooks also reconcile changes and close affected open file sockets when access is removed.

File sockets retain the verified session JWT's expiry. Every incoming message, outgoing update, and peer listing checks that expiry; expired or legacy connections close and reconnect through authenticated access checks. This works across Durable Object hibernation without resident timers or Clerk calls for cursor traffic. Session-ended, removed, and revoked webhooks also close that member's open sockets; other valid sessions can reconnect.

Migration `0002` adds the Clerk links without deleting historical users, workspaces, memberships, invites, files, or old key rows. Unlinked legacy rows do not grant access. Old cookies, GitHub/dev sign-in routes, and local agent keys are no longer accepted; names and logins never automatically claim historical data. See [the identity and OAuth decision](adr/0002-clerk-workspaces-and-oauth.md).

View links use a random 256-bit capability in `/s/:token`, enabled or revoked from file options. Migration `0003` adds the per-file share token. Anonymous viewer sockets accept source reads only, omit member identities and presence, and recheck token access on connection and source requests. Revocation fences upgrades already in flight as well as closing accepted sockets. A one-hour socket lease forces periodic revalidation without a resident timer. Anyone holding an enabled link can view the file's design content and inherited design system.

## Decisions

- [HTML-native design systems](adr/0001-html-native-design-system.md)
- [Clerk workspaces and OAuth](adr/0002-clerk-workspaces-and-oauth.md)
