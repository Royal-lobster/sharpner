# Sign-in and workspace home

Status: verified 2026-11-02 against commit 514347d (every step driven live).

A member signs in and lands on the workspace home. The home shows the `Files`
heading and a grid of the workspace's files. The member can create a file, which
opens its canvas, and can search the grid by file name.

## Sub-features

- `home-signin`: the verification member signs in and sees the workspace home.
- `home-new-file`: `New file` asks for a name, creates the file, and opens its canvas.
- `home-grid`: the grid shows each file as an `Open <file name>` link.
- `home-search`: `Search files` filters the grid; `Clear search` resets it.

## How to get to it (user POV)

- Open `/` while signed in.
- In an open file, select `All files` in the `File and pages` navigation.
- Select the `Sharpner home` mark in the home header.

## Driving it with verify.mjs

Preconditions:

- The instance is launched and Doctor has no `FAIL` row.
- The agent is connected (`node $V mcp-login`) for the second view.

- **Sign in.** Run `node $V signin`. The output ends with `Signed in as
  sharpner-verify+clerk_test@example.com in workspace "Sharpner Verify"`.
  `node $V doctor` reports `PASS browser member browser signed in as ...`.
- **See the empty home.** Run `node $V capture home empty`. The ARIA snapshot has
  `heading "Files"`, `button "New file"` and `heading "Start with a file"`.
- **Open the New file dialog.** Run `node $V ab find role button click --name "New
  file" --exact`. A dialog named `New file` opens with the textbox `File name`.
- **Create the file.** Run `node $V ab find label "File name" fill "Verify home
  file"`, then `node $V ab find role button click --name "Create file"`, then
  `node $V ab wait --url "**/f/**"`. The canvas opens and shows `This page is empty`.
- **Return home.** Run `node $V ab find role link click --name "All files"`, then
  `node $V ab wait --fn 'document.querySelector("h1")?.textContent === "Files"'`.
  The grid has `link "Open Verify home file"`.
- **Search with no match.** Run `node $V ab find label "Search files" fill
  "nothing-matches"`. The heading `No files match` appears.
- **Clear the search.** Run `node $V ab find role button click --name "Clear
  search"`. The `Open Verify home file` link returns.
- **Second view.** Run `node $V mcp get_app_state`. The response lists `Verify home
  file` under `workspaces[0].files`.
- **Proof.** Run `node $V capture home grid`. The screenshot shows the file card.

## Gotchas

- The workspace is empty at the start of every run, because app data is local to
  the run. Create a file before you check the grid.
- The header's workspace switcher is Clerk's organization switcher. Do not create
  or rename a workspace there: that writes to the Clerk development instance.
- `Connect agent` opens agent settings. Do not create agent keys from it; use
  `mcp-login` to connect the agent.
- `--name "New file"` without `--exact` can also match the empty state's second
  `New file` button. Both open the same dialog.
