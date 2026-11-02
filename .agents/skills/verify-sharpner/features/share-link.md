# Share link

Status: verified 2026-11-02 against commit 514347d (every step driven live).

A member creates a view link for a file. Anyone with the link can watch the file,
live, without signing in. A link viewer cannot edit, select, or comment. The member
can turn the link off, which disconnects viewers.

## Sub-features

- `share-create`: `Share file`, then `Create link`, shows the `Share link` URL.
- `share-view`: a signed-out viewer opens the link and sees rendered frames.
- `share-live`: an edit by the member's agent appears for the viewer without a reload.
- `share-read-only`: the viewer has no comments, share or selection controls, and Delete changes nothing.
- `share-turn-off`: `Turn off` stops the link and disconnects the viewer.

## How to get to it (user POV)

- Member: select `Share file` in the `Collaboration` navigation.
- Viewer: open the `/s/<shareToken>` URL from the member.

## Driving it with verify.mjs

Preconditions:

- Baseline preconditions, with the agent connected.
- The member browser shows `/f/<fileId>` with a rendered frame `<nodeId>` in section
  `<sectionId>`. Use the [Agent MCP loop](./agent-mcp-loop.md) fixture.

- **Open the share panel.** Run `node $V ab find role button click --name "Share
  file"`. The panel says `Create a link to let anyone view this file.`
- **Create the link.** Run `node $V ab find role button click --name "Create
  link"`, then `node $V ab wait 'input[aria-label="Share link"]'`. The panel says
  `Anyone with this link can view this file.`, and the share button gains
  `Link sharing is on`.
- **Read the link.** Run `node $V ab get value 'input[aria-label="Share link"]'`.
  It prints `http://127.0.0.1:5199/s/<shareToken>?page=<pageId>`. Run `node $V
  capture share created`.
- **Open it signed out.** Run `node $V viewer open '<share link>'`, then `node $V
  viewer wait --fn 'document.querySelectorAll("[data-frame] iframe").length >= 1'`.
  Run `node $V viewer eval 'window.Clerk?.user?.id ?? null'`, which prints `null`.
  Run `node $V capture --viewer share viewer`.
- **Check read-only controls.** In the viewer ARIA snapshot, the `Collaboration`
  navigation is absent, each frame has `Interact with <frame name>`, and the
  home link is `Sharpner`, not `All files`. Run `node $V viewer find role button
  click --name "File menu for <file name>"`. The menu shows `View only · Live` and
  only `Canvas controls`. Run `node $V viewer press Escape`.
- **Try to delete.** Run `node $V viewer click '[data-frame="<nodeId>"]
  .frame-body'`, then `node $V viewer press Delete`. The frame stays, and no
  `Selection` toolbar appears. `node $V mcp get_file '{"fileId":"<fileId>"}'`
  still lists the frame.
- **Watch a live edit.** Run `node $V mcp create_nodes
  '{"fileId":"<fileId>","sectionId":"<sectionId>","nodes":[{"name":"Viewer live
  card","width":480,"source":"<div class=\"p-8 bg-emerald-300\">Live for
  viewers</div>"}]}'` and note the returned node `id` as `<newNodeId>`. Run
  `node $V viewer wait --fn
  '[...document.querySelectorAll(".frame-label")].some((label) =>
  label.textContent === "Viewer live card")'`. The label proves the node arrived.
  The new frame can land partly off screen, so run `node $V viewer find role
  button click --name "Zoom to fit"`, then `node $V viewer wait --fn
  '!!document.querySelector("[data-frame=\"<newNodeId>\"] iframe")'`. Run `node
  $V capture --viewer share live`. The capture shows the painted frame.
- **Turn the link off.** If the share panel is closed, run `node $V ab find role
  button click --name "Share file"` first. Run `node $V ab find role button click
  --name "Turn off"`.
  A dialog asks `Turn off link sharing?`. Run `node $V ab find role button click
  --name "Turn off" --exact` inside the dialog. The panel returns to `Create link`.
  The viewer shows `This link isn’t shared anymore` after it reconnects or reloads
  (`node $V viewer reload`). Run `node $V capture --viewer share off`.

## Gotchas

- `Create link` also copies the link. Headless clipboard access can fail and show a
  `Could not copy` toast. The link is still created; read it from the input.
- The viewer is a separate browser profile with no Clerk session. Never sign it in.
- Link viewers read sources over the shared socket, so frames render only when
  Doctor's `browser-sockets` row passes for the member browser. The viewer uses the
  same init script.
- Turning the link off writes local D1 only. A new run starts with no links.
