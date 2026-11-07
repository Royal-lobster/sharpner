# Architecture

Sharpner runs as one Cloudflare Worker. The browser, REST routes, and MCP tools
share a file model; each file has one SQLite-backed Durable Object to serialize
edits and fan out changes.

## Finding your way around

| Module | Responsibility |
| --- | --- |
| `src/App.tsx` | Clerk sign-in, routing, and workspace bootstrap |
| `src/Landing.tsx` | Minimal signed-out introduction and hosted sign-in action |
| `src/Home.tsx` | Workspace file grid, search, and agent connection |
| `src/Editor.tsx` | File lifecycle, page organization, sharing, and presence |
| `src/file-startup.ts` | Bounded direct-file preconnection, identity verification, and ownership transfer |
| `src/Comments.tsx` | Canvas feedback list, thread conversations, and comment composition |
| `src/presence.ts` | Active member grouping across tabs and pages |
| `shared/design-system.ts` | Brand validation and token metadata for canvas specimens |
| `src/Canvas.tsx` | Camera, gestures, selection, and canvas composition |
| `src/canvas-location.ts` | URL-backed page and selection, deep-link resolution, and navigation history |
| `src/canvas-marquee.ts` | Marquee area, the selection it covers, and when a drag commits it |
| `src/canvas-layout.ts` | One active page's cached geometry, catalog labels, and navigation bounds |
| `src/canvas-render-plan.ts` | Viewport culling, preview layers, and live-content budgets |
| `src/live-frame.tsx` | Sandboxed live documents and no-flicker document swaps |
| `shared/component-scope.ts` | The components a live or playback document uses, so unrelated component edits leave it alone |
| `src/InteractionFrame.tsx`, `shared/interaction-document.ts` | Disposable viewer-local playback and its input/resource policy |
| `src/canvas-navigation.ts` | Content bounds, fitted overview, and camera constraints |
| `src/room.ts` | Realtime client, presence, and demand-loaded sources; it never sends canvas edits |
| `src/thumbnail-cache.ts` | Bounded image loading and decoded-pixel budget |
| `src/preview-loader.ts` | Batched preview transport, bitmap decoding and request backpressure |
| `src/touch-gestures.ts` | Touch navigation state machine |
| `src/components/ui/` | shadcn/ui primitives |
| `worker/index.ts` | HTTP routes and authenticated browser entry points |
| `worker/auth.ts` | Clerk verification and session/machine permission checks |
| `worker/oauth.ts` | OAuth protected-resource metadata and the MCP authorization challenge |
| `worker/accounts.ts` | Clerk identity projections and webhook reconciliation |
| `worker/data.ts` | Workspace-scoped D1 queries and file operations |
| `worker/assets.ts` | Asset and preview-batch delivery from R2 |
| `worker/viewer-access.ts` | Fencing for share-link lookups that race a viewer revocation |
| `worker/room.ts` | Per-file persistence, realtime sync, and preview queue |
| `worker/comments.ts` | Transactional SQLite comment storage and anchor lifecycle |
| `worker/mcp.ts` | Agent tools and input validation |
| `worker/skills/sharpner/` | The skill and references agents read through `read_skill` |
| `worker/friction.ts` | Agent friction reports, deduplication, and ranking |
| `worker/render.ts` | Shared document loading, compiled thumbnail CSS, and single-capture previews |
| `worker/render-sprite.ts` | Sprite previews: many nodes' documents in one page, laid out, captured once and cropped |
| `worker/thumbnail-queue.ts` | Shared browser admission, fair file/workspace turns, and automatic rendering budgets |
| `worker/thumbnail-policy.ts` | Automatic preview budgets and queue limits, including the temporary `BACKFILL` exception |
| `worker/thumbnail-css.ts`, `worker/render-fonts.ts` | Compiled Tailwind CSS and prepared fonts for rendered previews |
| `shared/types.ts` | Wire messages, documents, and design-system composition |
| `shared/session-principal.ts` | Immutable Clerk identity binding across HTTP, socket init, and SDK |
| `shared/comments.ts` | Comment input limits and node-relative pin coordinates |
| `shared/layout.ts` | Section geometry shared by canvas, tools, and screenshots |
| `shared/specimens.ts` | Component and token-sheet presentations |
| `shared/themes.ts` | Theme names declared in token CSS |
| `shared/bake-theme.ts` | Writes a former theme selection into HTML, for the theme-removal migration |
| `shared/thumbnails.ts` | Preview selection for a node |

Read [CONTEXT.md](../CONTEXT.md) for the vocabulary before changing the file model.
A workspace controls membership; a file contains pages; a page contains nodes.

## Design systems and libraries

Every page renders through the existing Canvas, including the file's optional page marked `kind: "design-system"`. The marker identifies primitive definitions for MCP and libraries; it no longer switches to a document viewer. Omitted kind remains an ordinary canvas page. A `page.put` choosing another Design System page atomically unmarks the previous one. The separate `page_kinds` SQLite table remains compatible with older writers, and changing kind never edits or deletes nodes.

The agent convention is three ordinary sections in order: **01 · Brand**, **02 · Foundations**, **03 · Primitive components**. Brand is an editable HTML guideline frame; Foundations contains token sheets; Primitive components contains only component definitions in an automatic catalog. Existing section layout groups family variants into rows and wraps them, using explicit sibling order rather than a separate layout engine. A family whose every variant is named `Family/Row/Column` lays out as a table instead (`familyRuns` and `catalogLabels` in `shared/layout.ts`): rows and columns follow first appearance, and the canvas raster draws the table: a dashed box, a header row of column names, a first column of row names, and dashed rules between cells, in place of each cell's label. Inner rules and headers drop out when zoomed too far to read; the box stays. Labels never simply disappear: a screen, component or family name the gap above its node can no longer hold becomes a chip inside the node's top-left corner (raster and DOM layers alike), a nested section title moves inside its section, and a section whose designs are too small on screen to label counts them in its title. Component previews and screenshots never include these rules. A catalog more than 1.5× taller than wide stacks its family rows in height-balanced columns (`catalogLayout` in `shared/layout.ts`), so long Design System pages stay roughly square; smaller catalogs keep one column. Agent guidance recommends shadcn/ui families first and keeps custom families after them. Feature screens and product compositions stay on their feature pages.

Brand metadata (`name`, image `logoUrl`, `guidelines`, `voice`) remains in room metadata and synchronizes through `brand.set` patches and init/sync messages. MCP exposes `set_brand` and `get_design_system`; metadata does not generate or rewrite the guideline frame. It survives page conversion/deletion. Library catalog metadata remains available to agents. The canvas displays local nodes; an ordinary link in the Brand frame opens the library's Design System canvas to inspect or edit inherited content, without copying its definitions. Local tokens and components override inherited definitions under the existing merge rules. Libraries do not re-export inherited catalogs. No document-specific iframe, preview controls, panels or comment mode remain.

- **Token sheets** (`kind: "tokens"`) contain Tailwind v4 CSS. For example, `@theme { --color-primary: #4f46e5; }` makes `bg-primary` available in every frame. Token sheets render as visual specimens. Named `[data-theme="dark"]`, `[data-theme="uwu"]`, or other equality selectors override token values; existing `.dark` overrides also work. These are theme contexts that screens opt into by writing `data-theme` (or a class) on their own root HTML. Sharpner never applies or switches a theme: there is no file-wide theme (removed 2026-11-01), no per-frame `theme` field and no component theme overrides (both removed 2026-11-02), and no document theme script, per-theme thumbnail cache or live-iframe theme hot-swap. A migration baked each formerly themed frame's theme into its HTML roots (`data-theme` and class on `<html>`/`<body>`) and renamed each component theme override to a standalone component named `"<Name> (<Theme>)"`. Theme names are still discovered from merged token CSS, including the library, and `get_design_system` lists them. Token sheets render a specimen comparing the default Light pane and every declared theme. Components hold one definition per tag; instances expand with it. Themes can change colors, fonts, radii, and shadows; scoped feature CSS can add decoration, while structural alternatives are separate components or screens. Web-font `@import url(...)` declarations become stylesheet links.
- **Components** (`kind: "component"`) contain reusable HTML. The name sets the tag: `Button/Primary` becomes `<x-button-primary>`. `{{label|Continue}}` takes an instance's `label` attribute or its default; `<slot></slot>` takes the instance's children. Components can compose other components. Tags are file-wide and names must remain unique, so feature components use a prefix such as `Portfolio/AssetRow` → `<x-portfolio-assetrow>`. Placement on a feature page conveys ownership, not visibility. Components have one definition per tag; theme differences go in token values or scoped CSS, and structural alternatives are separate components. Variants such as Primary/Ghost are distinct from themes such as Light/Dark/UwU.
- **Libraries** are ordinary files. A file can use one library from its own workspace, linked with `set_library`. The library contributes its own token sheets and components; the consuming file's definitions take precedence. Library edits update dependent files and regenerate affected thumbnails. Libraries export all their own definitions regardless of page, so use a dedicated foundations-and-primitives file to share across products. Libraries do not re-export their own linked libraries.

```html
<x-card title="Assets">
  <x-portfolio-assetrow title="USDC" meta="Ethereum" value="1,204.50"></x-portfolio-assetrow>
</x-card>
<x-button-primary label="Add money"></x-button-primary>
```

Components use light-DOM custom elements so Tailwind works inside them. Editing a component updates frames that use it, including through other components. Renaming it changes its tag, so its instances must also be updated. Instances support props and slots rather than arbitrary overrides of inner elements.

Agents call `read_skill()` before edits. It returns [SKILL.md](../worker/skills/sharpner/SKILL.md), which links to task references. The same tool reads those files by path. Startup instructions stay short. For product design, agents read `get_design_system`, reuse existing definitions, and inspect screenshots. See the [design-system reference](../worker/skills/sharpner/references/design-system.md), [screen reference](../worker/skills/sharpner/references/screens.md), and [architecture decision](adr/0001-html-native-design-system.md).

## Rendering and loading

Workspace cards use a file's **cover**. An agent can pin an ordinary
frame or image with the `cover.set` operation (`set_cover` over MCP).
The FileRoom stores the chosen node ID in metadata and resolves its latest
preview through the existing thumbnail pipeline, mirroring the resulting URL
into D1's `files.cover`. The choice survives edits and room hibernation; a
pending first preview uses an automatic fallback without losing the pin.
Deleting the chosen node, its containing section or its page clears the choice.
`get_file` reports the choice and URL, while socket init/sync messages carry
`coverNodeId` to keep the canvas current. Agent-authored covers conventionally
live as fixed 1600 × 900 HTML frames on a described Cover page.

Layout is automatic everywhere. `layoutRects` in `shared/layout.ts` places every
node from its order, size and section: nodes in rows, consecutive sibling
sections tiled in columns, and each page's top-level nodes the same way from the
origin. Nothing is positioned by hand, so nodes never overlap. A run of sections
that holds screens picks the column count closest to a 1.6:1 block from stored
heights; heights a live view reports move a section down its column but never
into another, so every viewer and agent sees the same columns. Stored x/y remain
in FileRoom storage but layout ignores them. The migration that made every
section automatic lists the formerly free sections under the `freeSections` meta
key.

Each mounted canvas keeps one world-layout snapshot. Camera movement, presence,
source delivery, preview loading and agent effects reuse its rectangles and
catalog labels. Node/page changes and measured heights
invalidate it. Changing pages replaces the snapshot instead of retaining a
geometry cache for every visited page. Painting remains Canvas 2D with DOM/live
HTML promotion at close zoom.

Navigation caches the page's world bounds separately from comment state and
viewport size. Comment summaries, resolution, deletion and HTTP write completion
invalidate navigation without invalidating node geometry. A resolved thread
contributes its pin only while it is active. Resizing the comments panel updates
camera constraints through the visible canvas size.

Only visible nodes, plus a margin, are considered. Rendering switches with on-screen size:

| On-screen width | Rendered as |
| --- | --- |
| Up to about 280 device px, including tiny nodes | Lazy 256px WebP thumbnail on the canvas |
| Larger | DOM node with a 1280px thumbnail |
| At least 360 CSS px, among the six largest, camera at rest | Live sandboxed iframe with source fetched on demand |

Components can become live from 220 CSS px wide; screen previews use the thresholds above. Without thumbnails, up to twelve nodes can become live from 140 CSS px wide. The low-resolution cache admits a stable viewport working set, capped at 600 images, 16 million decoded pixels, and sixteen concurrent loads. Dense views beyond that budget use boxes until navigation makes room; they do not continuously evict and reload each other. Original image uploads are promoted only for up to eight large, actually visible images.

Source edits, token edits, edits to a component the document uses, and cold assets
use the fresh-document swap (the warm theme-only update path was removed with theme
switching on 2026-11-02). A live document embeds only the components whose tags
appear in its HTML, scripts and nested components included. The match is textual,
so a tag inside a longer word (`x-row` in `flex-row`) also counts. An edit to a
component the document never mentions builds the same document and keeps its
iframe; HTML that builds tag names at runtime embeds them all. Thumbnails and
screenshots scope each document the same way (`documentDesign` in `worker/render.ts`), so a
sprite of 24 nodes no longer carries 24 copies of a design system that can hold hundreds of
components; before this, a file with a large library and page-sized components exceeded the
FileRoom's memory limit while rendering. Overview admission remains bounded by
the policy above. See [live canvas experiments](live-canvas-rendering.md) for the
measured alternatives and the larger interactive rendering plan.

Any frame or component can be played. Interact admits one disposable
input-enabled document per viewer on top of the normal live budget; it does not
change content revisions, previews or room state. Stop, Reset and Escape control
its lifecycle; input and transient heights stay local. Shared-link viewers can
play designs without editing them. See [interaction playback](interaction-playback.md)
for lifecycle, resource policy and isolation limits.

Visible frames, components, and token sheets can sharpen on the canvas before reaching the DOM threshold. Once the initial small-preview pass is complete and the camera stops, nodes at least 64 device pixels wide can load their sharper preview through a separate queue capped at 32 entries, 32 million decoded pixels, and two concurrent image loads. A separate transport uses one stable high-preview batch at a time while retaining the two-image decode limit. Admission estimates match the renderer's maximum width of 1280px without assuming smaller frames are enlarged. This keeps the working set stable instead of replacing batches as actual image sizes arrive. The small preview stays visible until the sharper one is ready. Data Saver and limited connection hints disable this optional work; browsers without those hints use the bounded queue. These upgrades fetch neither live sources nor original image uploads, and cached sharp previews remain visible during navigation.

Initial sync sends geometry, with HTML fetched only for live nodes and the file's design-system definitions. The reusable screen-source cache is limited to 128 entries / 8 MiB of UTF-16 text; the current live working set and required design definitions remain pinned. Matching source revisions survive reconnects. Source requests have backpressure, and responses stream in byte-bounded batches. The HTML starts public sign-in configuration and Clerk script preloads while the application bundle downloads; React shares the parsed configuration and retains its normal retry flow. Shared view links skip this bootstrap, and old hostnames wait to redirect before loading Clerk. The workspace bootstrap returns the verified account and active workspace's file summaries together, avoiding a second authenticated request before showing file cards; later file changes refresh through the workspace detail route. The editor and signed-out landing page load in separate chunks. On direct file and shared links, the initial HTML preloads the emitted editor chunk and its static imports while sign-in initializes; workspace and landing routes skip those downloads. Editor mounting uses an explicit loading state, avoiding a Suspense fallback delay before file metadata and the socket can start even when editor modules are cached. The landing page redirects to Clerk's hosted Account Portal for sign-in and sign-up, preserving the current same-origin file/page/selection URL; it contains no embedded authentication form. Agent setup and imperative dialogs download on their first action; the dialog interface captures the initiating control before loading, safely cancels failed downloads or disconnected controls, and preserves focus restoration. Direct file loads start metadata and the socket concurrently, obtain the verified author with file metadata, and skip the separate account bootstrap request. Current Clerk user and membership reads run concurrently without caching authorization.

Hashed build assets under `/assets/` have immutable browser caching, so cached refreshes do not revalidate each JavaScript, CSS, and font file. HTML and authenticated responses retain their separate cache policies. The direct-file preload script runs before the built stylesheet, after the public auth bootstrap, avoiding a stylesheet wait before editor downloads. Ready canvas content appears immediately, without a blur-and-fade entrance.

Account reconciliation still fetches current Clerk user and membership data on every authenticated request. Its normal database path uses two batches: read the previous author and removed memberships, then write the projection and return the reconciled author and workspaces atomically. Removed-member sockets must finish revoking before the projection batch can prune membership.

Direct file startup can overlap Clerk SDK initialization. After public configuration
has passed the canonical-origin check and the lazy editor module is available, a
nonempty `__session` cookie is only a hint to start one abortable cookie-authenticated
metadata request and one quiet Room. Both requests still perform ordinary server
authorization and fresh membership reconciliation. Workspace routes do no editor,
socket, or file API prefetch; shared links retain their anonymous startup.

The route owns the pending attempt until Editor claims it. A claim does not expose
data: metadata and authenticated socket `init` must carry matching verified Clerk
user ID, session ID, and active organization context, and all three must match the
loaded SDK identity. Local author and workspace IDs cannot establish this binding.
The file's workspace can differ from the credential's active organization; the
existing workspace switch closes that attempt and starts under the new context.
Anonymous socket init omits the principal and member lease entirely.

Pending state lives only in memory for at most five seconds, with at most 128
socket messages / 4 MiB of UTF-16 message data and 1 MiB of metadata. The Room sends
no presence, source requests, renewal, or reconnect work before adoption. Failures,
expired leases, unsupported old init/metadata, identity mismatches, route departure,
and sign-out discard the attempt. Editor owns adopted Room cleanup; same-file page,
selection, and query navigation retain it. Account, session, and organization changes
remount the authenticated destination. The normal SDK-backed path remains the
rolling-deployment fallback for old servers without principal fields; when either
response supplies a principal, both must match the SDK before canvas display.
Adopted/current-server connections also recheck the binding on reconnect. Nothing
stores auth or prefetched private data in localStorage or a service worker.

Worker fetch handlers use Cloudflare Smart Placement to reduce waits on upstream services. Static build assets still serve at the edge. Placement needs traffic to learn suitable locations; inspect `cf-placement` and measure authenticated socket readiness and preview loading after deployment. Asset routes use the location's Cache API, so a placement change can initially miss previews cached elsewhere.

The file's Durable Object renders the first edit after a quiet spell at once and debounces later edits in a burst for 1.2 seconds. A shared `ThumbnailQueue` grants one browser slot across automatic previews and explicit screenshots. Automatic work runs whether or not anyone has the file open, so a preview follows an agent's edit, including every screen and component that uses an edited component, without waiting for a viewer. It gives workspaces and files fair turns and prioritizes viewed pages. Daily file/workspace/global browser-time budgets are recorded but set far above any real day (lifted 4 Nov 2026). A browser session spans up to eight seconds of queue work with four tabs, re-querying between batches of 96. Each tab renders a sprite of up to 24 nodes from one page, one iframe per node, captured once; a node that cannot share a sprite renders alone. A design-system edit does not end the session: revision checks drop the renders it superseded. A healthy turn leaves its browser running for 60 seconds, and the next automatic turn reconnects to it instead of launching. Failed pairs retry up to three times. Superseded objects are deleted while one selected fallback remains visible. See [thumbnail rendering](thumbnail-rendering.md) for policy, measurements, costs and alternatives. Thumbnails use immutable R2 URLs. Small viewport previews are fetched in groups of up to sixteen immutable thumbnail names, with four batches in flight. A preview keeps its group while it stays admitted, so a pan requests only the previews it newly admits; newly admitted names are sorted before grouping, so the opening view's keys stay stable. Each response reads at most eight R2 objects concurrently and includes at most 1 MiB of image bytes; missing, over-budget or undecodable images fall back to their individual URLs. Batch previews decode to bitmaps before their first paint, and the cache closes a bitmap as soon as it evicts it. Groups and prefetched encoded data are bounded by the canvas's admitted viewport working set and released on navigation or disposal. Larger previews use a separate single-batch loader with the existing 32-million-pixel budget and two-image decode limit. Original uploads keep native image loading and HTTP caching.

The asset routes cache successful immutable images and complete preview batches at the edge and preserve their sandbox headers. New batches reuse cached individual images before reading R2; successful R2 reads populate both caches. Individual asset queries normalize to the R2 path; versioned batch keys sort and deduplicate the exact revisioned names. Partial or missing previews are not cached. Agent-created images without a supplied preview enter the rendering queue, producing a preview up to 400px wide / 1600px tall while retaining the original for close viewing. Browser uploads can supply their own preview. Without Browser Rendering, unpreviewed images use boxes at low zoom and the original at close zoom.

A component in a catalog section on the marked Design System page is a **catalog specimen** (component sections on feature pages, which often hold whole screens as components, keep single previews, and so does a family whose cells would be wider than 2400px): one row of cells, each the instance on its theme's background at the component's own width, for every compared theme (Dark and Light when the token CSS declares one as the alternative to its default) times every value of the first prop that lists its values (`{{size|md|sm,md,lg}}`), with its authored examples under each theme's cells. The FileRoom derives each member's cells from its family in `refreshSpecimens` (`familySpecimens` in `shared/catalog-specimens.ts`): one column list and one cell width, the widest member's, shared by the whole family, stored in the `specimen` column and node metadata. A member whose cells change, including because a sibling widened them or the tokens' themes changed, gets a new revision. The node lays out and renders at the cells' total width; the specimen rules between its own cells, and the canvas draws the family's box, theme and value headers and row names. A family whose names are all `Family/Row/Column` keeps its table of nodes and only gains theme cells. A component's description is its usage note, which the catalog shows by the family name; small families share a catalog row and are named above their block. Elsewhere, component nodes show only their real default instance on the file's background, laid out at the node's full width as a frame of that width lays it out, with 12px above and below and no caption; MCP reports the tag, props and slot support. The canvas marks a component with its purple `◆` label and a purple edge, drawn outside the preview so screenshots stay clean. Automatic specimens fit their content. An auto-height frame or component renders first in an 800px viewport, then in a viewport fitted to its measured height until the content settles, which is the viewport its live canvas iframe has; `position: fixed`, sticky bottoms and viewport units therefore land in the same place in previews, `screenshot_nodes` and the live canvas. Content that keeps growing with its viewport keeps the 800px layout. Token sheets show a responsive catalog on the same surface, including resolved values for declared named themes. Agents group related variants using ordinary sections. The shared layout function supplies geometry to the canvas, screenshots, and agent tools.

Known limitations: the initial sync still includes geometry for the whole file, including other pages; HTML and image loading are lazy. Canvas-layer nodes paint beneath DOM-layer nodes, so overlapping nodes of very different on-screen sizes can stack incorrectly. Zoomed-out edits appear after the replacement thumbnail is ready. Generating new previews is separate from opening an existing file with previews ready.

Touch navigation uses one finger to pan, two to pinch, and a double-tap to fit a design. Native non-passive touch and Safari gesture handlers keep canvas gestures from becoming page gestures, including when a finger leaves the surface. The editor contains document overscroll; workspace pages and menu scrolling retain their browser behavior. Navbar marks use a tightly framed transparent SVG, separate from the tile used for the favicon and Clerk branding. Responsive layouts retain the same Mira component sizes and padding; mobile changes rearrange controls and constrain widths, rather than enlarging buttons, tabs, inputs, or menus.

Preview navigation locks panning at the fitted overview, which is also the minimum
zoom. Above that zoom, panning is free on both axes so any part of a design can be
centered and titles can be moved clear of floating controls. Returning to Fit or
pinching back to the minimum zoom restores the content overview and its margins.
All camera writes, including mouse/trackpad, touch, keyboard, animated focus and restored views,
use the same constraints. Bounds update with live layout and viewport changes;
visible comment pins also contribute so detached feedback remains reachable.
Empty pages fit a virtual 800×600 area until content arrives. Page changes cancel
pending camera animation and persistence work.

File URLs and anonymous view links include `?page=<page-id>` and one `node=<node-id>`
parameter per selected node. Explicit links override the recipient's remembered
page and fit the linked selection after the initial room snapshot, even when a
camera was saved locally. Selecting nodes replaces the current history entry
without moving the camera; switching pages adds an entry. A marquee drag shows
its selection on the canvas and in the selection toolbar as it grows, and writes
the URL once, on release or lost pointer capture, because browsers throttle history
writes; peers and agents see the result then.
Back and Forward restore the linked page and selection. Deleted targets fall
back to an existing page, and selection is always limited to nodes on that page.
Links without a target retain the remembered-page behavior.

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

The comment panel floats over the desktop canvas. On mobile, its actual height
reserves canvas space so focused pins use the visible preview area. Closing the
panel or switching threads preserves unfinished text during the editor session; closing also returns
keyboard focus to the comments control.

Clerk Users identify people; Clerk Organizations are workspaces. Personal Accounts are disabled. The browser uses Clerk sign-in, the organization switcher, and the account menu. Workspace membership and invitations are managed in Clerk rather than separate Sharpner forms.

Sharpner verifies credentials against its configured Clerk instance, then reconciles the person's current memberships before each authenticated HTTP request. D1 preserves stable local author/workspace IDs linked to immutable Clerk IDs; supported roles are `org:admin` → owner and `org:member` → member. Signed Clerk webhooks also reconcile changes and close affected open file sockets when access is removed.

File sockets retain the verified session JWT's expiry and session ID. The browser renews the lease 15 seconds before expiry through an authenticated HTTP request with a freshly requested Clerk token. Renewal rechecks current workspace/file access and requires the same file, author, session, connection ID, and configured issuer. It updates the persisted attachment without reconnecting or resending the canvas. Every incoming message, outgoing update, and peer listing still checks expiry; expired or legacy connections close and reconnect through authenticated access checks. This works across Durable Object hibernation without resident server timers or Clerk calls for cursor traffic. Session-ended, removed, and revoked webhooks also close that member's open sockets; other valid sessions can reconnect.

Migration `0002` adds the Clerk links without deleting historical users, workspaces, memberships, invites, files, or old key rows. Unlinked legacy rows do not grant access. Old cookies, GitHub/dev sign-in routes, and local agent keys are no longer accepted; names and logins never automatically claim historical data. See [the identity and OAuth decision](adr/0002-clerk-workspaces-and-oauth.md).

View links use a random 256-bit capability in `/s/:token`, enabled or revoked from file options. Migration `0003` adds the per-file share token. Member sockets accept presence and source reads; the canvas is view only in the browser, and a stray edit message is refused with a fresh `init`. Agents change the canvas through MCP. Anonymous viewer sockets accept source reads only, omit member identities and presence, and recheck token access on connection and source requests. Revocation fences upgrades already in flight as well as closing accepted sockets. A one-hour socket lease forces periodic revalidation without a resident timer. Anyone holding an enabled link can view the file's design content and inherited design system.

## Decisions

- [HTML-native design systems](adr/0001-html-native-design-system.md)
- [Clerk workspaces and OAuth](adr/0002-clerk-workspaces-and-oauth.md)
