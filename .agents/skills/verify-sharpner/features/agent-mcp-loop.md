# Agent MCP loop

Status: verified 2026-11-02 against commit 514347d (every step driven live).

A member connects an agent, and the agent works in the member's workspace through
MCP. When the agent adds or edits frames, the change appears on the member's open
canvas without a reload and renders as a live preview. The agent sees which file,
page and selection the member has, and can screenshot frames.

## Sub-features

- `mcp-connect`: the agent connects through Clerk OAuth with the member's approval.
- `mcp-state`: `get_app_state` shows the member, the workspace, and the open file, page and selection.
- `mcp-create-live`: `create_section` and `create_nodes` add a frame that appears and renders on the open canvas.
- `mcp-edit-live`: `edit_node_source` changes the open frame without a reload.
- `mcp-screenshot`: `screenshot_nodes` returns a rendered image of a frame.

## How to get to it (user POV)

- The member selects `Connect agent` on the workspace home and follows the
  instructions. The harness runs the same OAuth flow with `node $V mcp-login`.
- The agent calls tools on `/mcp`. The harness calls them with `node $V mcp
  <tool> '<json>'`.

## Driving it with verify.mjs

Preconditions:

- Baseline preconditions. `node $V doctor` shows `PASS browser-sockets`.

- **Connect the agent.** Run `node $V mcp-login`. The output ends with `Agent
  connected through Clerk OAuth`. Doctor shows `PASS agent`.
- **List tools.** Run `node $V mcp --list`. The list includes `get_app_state`,
  `create_file`, `create_section`, `create_nodes`, `edit_node_source` and
  `screenshot_nodes`.
- **Read the member's state.** Run `node $V mcp get_app_state`. The response names
  the member `Sharpner Verify` and the workspace `Sharpner Verify` with its `id`.
- **Create a file.** Run `node $V mcp create_file
  '{"workspaceId":"<workspaceId>","name":"Verify MCP loop"}'`. The response has
  `fileId` and the first page's `id`.
- **Open it as the member.** Run `node $V open /f/<fileId>`, then `node $V ab wait
  --text "This page is empty"`, then `node $V capture mcp-loop before`.
- **Mark the page.** Run `node $V ab eval 'window.__verifyMarker = 1'`. A reload
  would clear this marker.
- **Check the agent sees the file.** Run `node $V mcp get_app_state`. `active.file`
  is `Verify MCP loop` and `active.page` is `Page 1`.
- **Add a section.** Run `node $V mcp create_section
  '{"fileId":"<fileId>","name":"Verify"}'`. The section label `Verify` appears on
  the canvas.
- **Add a frame.** Run `node $V mcp create_nodes
  '{"fileId":"<fileId>","sectionId":"<sectionId>","nodes":[{"name":"Verify
  card","width":480,"source":"<div class=\"p-10 bg-amber-400 text-black\"><h1
  class=\"text-4xl font-bold\">Hello from MCP</h1><p class=\"mt-2
  text-lg\">Created by the verify-sharpner agent loop.</p></div>"}]}'`. The
  response has the new node `id`.
- **See it render live.** Run `node $V ab wait --fn
  'document.querySelectorAll("[data-frame] iframe").length === 1 &&
  !document.querySelector(".frame-placeholder") &&
  getComputedStyle(document.querySelector("[data-frame] iframe")).opacity === "1"'`.
  Then run `node $V ab eval 'window.__verifyMarker === 1'`, which prints `true`.
  Then run `node $V capture mcp-loop rendered`. The screenshot shows the amber card.
- **Edit the frame.** Run `node $V mcp edit_node_source
  '{"fileId":"<fileId>","nodeId":"<nodeId>","edits":[{"find":"Hello from
  MCP","replace":"Edited by MCP"}]}'`, then wait two seconds with `node $V ab wait
  2000`. Run `node $V capture mcp-loop edited`. The screenshot shows `Edited by
  MCP`, and the marker is still `true`.
- **See the selection.** Run `node $V ab click '[data-frame="<nodeId>"]
  .frame-body'`, then `node $V mcp get_app_state`. `active.selection` lists the
  node with `kind` `frame`.
- **Screenshot through the agent.** Run `node $V mcp screenshot_nodes
  '{"fileId":"<fileId>","nodeIds":["<nodeId>"]}'`. The command prints `image:
  <run dir>/evidence/mcp/NN-screenshot_nodes-0.png`, which shows the edited card.
- **Proof.** The `evidence/mcp-loop/` captures and the `evidence/mcp/` response
  bodies prove the loop.

## Gotchas

- The edit appears without a reload but stays on `Rendering…` when the browser
  cannot send on its socket. Doctor's `browser-sockets` row then fails. Run `node
  $V ab close`, then `node $V signin`.
- `ab wait --fn` needs a boolean. `document.querySelector(...)` alone returns an
  element and does not work.
- The preview iframe is sandboxed, so the page cannot read its text. Prove the
  rendered content with a screenshot or `screenshot_nodes`.
- If the marker is gone after an edit, the page reloaded and the live update is
  not proven. Open the file again and repeat the edit.
- `mcp` saves every response under `evidence/mcp/`, numbered in call order. Cite
  those files, not the terminal output.
- Cleanup revokes the agent connection. Run `mcp-login` again in a new run.
- Click a frame's body to select it. Its label sits above the frame's bounds, so a
  click on the label selects the section around the frame instead.
