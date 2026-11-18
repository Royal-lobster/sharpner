# Approvals and design dates

A member approves a frame from the selection bar. An agent edit afterwards keeps
the approval and flags the frame as changed since approval. Agents approve with
the `approved` field of `update_nodes` and read dates and approvals in `get_file`
and `read_nodes`.

## Preconditions

- Baseline, with the agent connected.
- A fixture file with one frame:

```sh
node $V mcp create_file '{"workspaceId":"<workspaceId>","name":"Verify approvals"}'
node $V mcp create_nodes '{"fileId":"<fileId>","nodes":[{"kind":"frame","name":"Home","width":390,"source":"<main class=\"p-8\">Home</main>"}]}'
```

## Steps

- **Dates.** Run `node $V open "/f/<fileId>?node=<nodeId>"`. The selection bar shows
  `Home`, then `Changed just now`. Hover it: the tooltip reads `Created … · Last
  changed …`. Run `node $V capture approvals selected`.
- **Approve.** Run `node $V ab find role button click --name "Approve" --exact`. The
  button becomes `Approved` with a pressed state. Run `node $V capture approvals approved`.
- **Second view.** Run `node $V mcp read_nodes '{"fileId":"<fileId>","nodeIds":["<nodeId>"]}'`.
  The node has `createdAt`, `changedAt` and `approval` with `approvedBy`
  `Sharpner Verify` and `changedSinceApproval: false`.
- **Agent edit.** Run `node $V mcp edit_node_source` to change `Home` to `Welcome`.
  Without a reload, the button reads `Approve again`. Run `node $V capture approvals changed`.
- **Agent approval.** Run `node $V mcp update_nodes
  '{"fileId":"<fileId>","updates":[{"nodeId":"<nodeId>","approved":true}]}'`. The
  button returns to `Approved`; its tooltip names `Sharpner Verify's agent`.
- **Withdraw.** Select `Approved`, then `Withdraw` in the dialog. The button reads
  `Approve`.
- **Narrow width.** Run `node $V ab set viewport 390 844`. The bar keeps `Approve`
  and the dates and fits the screen. Run `node $V capture approvals narrow`.
- **View link.** Share the file and open it with `viewer`. Link viewers see no
  selection bar and receive no approvals.

## Gotchas

- Only frames show the approval button. Components, images, sections and token
  sheets show dates only.
- Designs made before design dates have no dates; the bar shows none.
