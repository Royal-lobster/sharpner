# Sharpner verification map

This directory is the maintained source for verifying what members and agents can
do in Sharpner. Read this index before you drive the app. Then use the matching
feature file as the recipe. Every command uses `V` from [SKILL.md](../SKILL.md):

```sh
V=".agents/skills/verify-sharpner/scripts/verify.mjs"
```

## Baseline preconditions

- `node $V launch` printed `Ready: http://127.0.0.1:5199`, and `node $V doctor` has
  no `FAIL` row.
- `node $V signin` signed the member browser in as
  `sharpner-verify+clerk_test@example.com` in the workspace `Sharpner Verify`.
- `node $V mcp-login` connected the agent, for features that use MCP.
- Each run starts with an empty workspace: no files, no comments, no share links.
  The Clerk member and workspace persist between runs; the app data does not.
- Never drive an instance that this run did not start.

## Driving conventions

- Start each recipe from the baseline unless its preconditions say otherwise.
- Make fixtures through the user path or MCP tools, never through internal APIs.
  Each recipe shows the MCP calls that make its fixture file.
- Find elements by role and accessible name (`ab find role button click --name
  "Share file"`), then by `data-frame` and route. Never use coordinates.
- `--name` matches a substring. Add `--exact` when one name contains another,
  such as the `Page 1` menu button and the `Page 1 3 designs` page option.
- `ab wait --fn` takes an expression that returns a boolean.
- Replace `<fileId>`, `<pageId>`, `<sectionId>`, `<nodeId>` and `<workspaceId>` with
  the IDs that the previous MCP response printed. `get_app_state` lists the
  workspace ID.
- Use the member browser (`ab`) for member actions and the viewer browser
  (`viewer`) for signed-out actions.

## Proof and skip reporting

- Capture the action and the result: a `capture` before and after each change.
- UI proof is a screenshot plus an ARIA snapshot (`node $V capture <feature>
  <label>`). The screenshot shows the Sharpner file or workspace name.
- Agent proof is the MCP response body in `evidence/mcp/`.
- Mutation proof needs a second view: an MCP read after a browser write, or a
  browser observation after an MCP write.
- Name captures by feature ID so the evidence maps to the recipe.
- Report a path you could not reach as verified-unreachable, with the command you
  ran and the missing prerequisite.
- Never report an entry point as verified because a different entry point worked.

## Feature entry contract

Each feature file starts with an H1 title, a `Status:` line, and one paragraph
about the user-visible behavior. The status is `verified`, `verified-unreachable`
or `unproven`, with the date and the evidence directory of the last live run.
Then the file has exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every entry point a member or agent uses.
3. `Driving it with verify.mjs` starts with `Preconditions:` and uses labeled
   bullets. Each bullet pairs a user action with an exact command and the result
   you can observe.
4. `Gotchas` lists traps that waste or invalidate a run.

Keep implementation details out of the map. Name user paths, stable handles,
required state, commands and observable proof.

## Features

- [Sign-in and workspace home](./sign-in-and-home.md): sign-in, the file grid,
  New file, and search.
- [File canvas](./file-canvas.md): direct file links, live frame rendering, page
  switching, and zoom.
- [Agent MCP loop](./agent-mcp-loop.md): agent connection, MCP edits that appear
  and render live on an open canvas, the member's selection, and agent screenshots.
- [Comments](./comments.md): pin, reply, resolve and reopen in the browser, and the
  same threads through MCP.
- [Share link](./share-link.md): create a view link, watch as a signed-out viewer,
  confirm the viewer cannot edit, and turn the link off.
