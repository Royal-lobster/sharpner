# File canvas

Status: verified 2026-11-02 against commit 514347d (every step driven live).

A member opens a file from a direct link and sees its canvas. Frames render their
HTML as live previews, then get thumbnails. The member switches pages from the
page menu, and the URL follows the page. The zoom toolbar changes and fits the view.

## Sub-features

- `canvas-direct-link`: `/f/<fileId>` opens the canvas without the home first.
- `canvas-frames-render`: each visible frame shows a live preview, not `Rendering…`.
- `canvas-thumbnails`: the local renderer makes thumbnails for the viewed page.
- `canvas-page-switch`: the page menu switches pages and sets `?page=<pageId>`.
- `canvas-zoom`: `Zoom in`, `Zoom out`, `Zoom to fit` and the 100% reset change the view.

## How to get to it (user POV)

- Open `/f/<fileId>` directly, for example from a link an agent prints.
- Select `Open <file name>` on the workspace home.
- Open `/f/<fileId>?page=<pageId>` to land on one page.

## Driving it with verify.mjs

Preconditions:

- Baseline preconditions, with the agent connected.
- A file with two frames on its first page and an empty second page. Make it with
  MCP: `node $V mcp create_file '{"workspaceId":"<workspaceId>","name":"Verify
  canvas"}'`, then `node $V mcp create_section
  '{"fileId":"<fileId>","name":"Screens"}'`, then `node $V mcp create_nodes
  '{"fileId":"<fileId>","sectionId":"<sectionId>","nodes":[{"name":"Amber
  card","width":480,"source":"<div class=\"p-10 bg-amber-400\"><h1
  class=\"text-4xl font-bold\">Amber</h1></div>"},{"name":"Sky
  card","width":480,"source":"<div class=\"p-10 bg-sky-300\"><h1
  class=\"text-4xl font-bold\">Sky</h1></div>"}]}'`, then `node $V mcp create_page
  '{"fileId":"<fileId>","name":"Second page"}'`.

- **Open by direct link.** Run `node $V open /f/<fileId>`, then `node $V ab wait
  --fn 'Boolean(document.querySelector(".canvas[data-ready]"))'`. The `File and
  pages` navigation shows `File menu for Verify canvas` and the status `Live`.
- **Frames render.** Run `node $V ab wait --fn
  'document.querySelectorAll("[data-frame] iframe").length === 2 &&
  !document.querySelector(".frame-placeholder")'`, then `node $V capture canvas
  frames`. The screenshot shows both cards with their Tailwind colors.
- **Thumbnails exist.** Run `grep thumbnail-turn <run dir>/evidence/logs/server.log`.
  A line reports `"rendered":2` for the file.
- **Open the page menu.** Run `node $V ab find role button click --name "Page 1"
  --exact`. The panel lists `Page 1 2 designs` and `Second page 0 designs`.
- **Switch pages.** Run `node $V ab find role button click --name "Second page"`,
  then `node $V ab wait --text "This page is empty"`. `node $V ab get url` ends with
  `?page=<second pageId>`.
- **Switch back.** Run `node $V ab find role button click --name "Second page"
  --exact`, then `node $V ab find role button click --name "Page 1"`. Both frames
  return with live previews.
- **Zoom.** Run `node $V ab find role button click --name "Zoom in"`. The zoom button
  name changes to a larger `Zoom <n>%, reset to 100%`. Run `node $V ab find role
  button click --name "Zoom to fit"` to fit the page again.
- **Proof.** Run `node $V capture canvas page-1-fit`.

## Gotchas

- A frame on `Rendering…` with no iframe means the browser cannot send on its
  socket. Doctor's `browser-sockets` row fails. Run `node $V ab close`, then
  `node $V signin`.
- Thumbnails render only for a page that a member views. A frame made while no
  member has the page open stays without a thumbnail until someone opens it.
- The page menu button's name is the page name alone. Page options add the design
  count, so `--name "Page 1" --exact` selects the menu button.
- The canvas saves each page's camera in local storage. A reopened page restores
  that camera instead of fitting the content.
- The sandboxed preview iframe is not readable from the page. Prove its content
  with a screenshot.
