# Comments

Status: verified 2026-11-02 against commit 514347d (every step driven live).

A member pins a comment to a spot on a frame, replies to it, and resolves it. The
comments panel lists open and resolved threads. Agents read and answer the same
threads through MCP, and their replies appear in the member's panel.

## Sub-features

- `comments-pin`: `Add a comment` and a click on a frame pin a new thread there.
- `comments-reply`: the member replies in the thread.
- `comments-resolve`: `Resolve` closes the thread; `Reopen` opens it again.
- `comments-agent`: `list_comments` and `reply_to_comment` read and answer the same thread.

## How to get to it (user POV)

- Select `Comments, <n> open` in the `Collaboration` navigation, then `Add a
  comment`.
- Press `C` on the canvas while no text field has focus.
- Select a pin on the canvas, named `Comment <n> by <author>: <text>`.

## Driving it with verify.mjs

Preconditions:

- Baseline preconditions, with the agent connected.
- The member browser shows `/f/<fileId>` with one rendered frame `<nodeId>`. Make
  it with the first five steps of [Agent MCP loop](./agent-mcp-loop.md) up to
  **Add a frame**, or with the file canvas fixture.

- **Open the panel.** Run `node $V ab find role button click --name "Comments, 0
  open"`. The `Comments` panel shows `No open comments`.
- **Start a comment.** Run `node $V ab find role button click --name "Add a
  comment"`. The status `Click a spot to leave a comment` appears.
- **Pin it to the frame.** Run `node $V ab click '[data-frame="<nodeId>"]'`. The
  textbox `Your comment` appears with the location `Page 1 · <frame name>`.
- **Post it.** Run `node $V ab find label "Your comment" fill "Make the heading
  larger"`, then `node $V ab find role button click --name "Post comment"`. The pin
  `Comment 1 by Sharpner Verify: Make the heading larger` appears, and the thread
  opens. Run `node $V capture comments pinned`.
- **Reply.** Run `node $V ab find label "Reply to comment" fill "Agreed, bumping to
  text-5xl"`, then `node $V ab find role button click --name "Reply" --exact`, then
  `node $V ab wait --text "Agreed, bumping to text-5xl"`.
- **Agent reads the thread.** Run `node $V mcp list_comments
  '{"fileId":"<fileId>"}'`. One open thread has `messageCount` 2. Note its `id`.
- **Agent replies.** Run `node $V mcp reply_to_comment
  '{"fileId":"<fileId>","threadId":"<threadId>","body":"Done in the next
  edit."}'`, then `node $V ab wait --text "Done in the next edit."`. The reply
  appears in the open thread without a reload.
- **Resolve.** Run `node $V ab find role button click --name "Resolve" --exact`,
  then `node $V ab wait --text "Resolved by Sharpner Verify"`. The dock button reads
  `Comments, 0 open`. Run `node $V capture comments resolved`.
- **Second view.** Run `node $V mcp list_comments
  '{"fileId":"<fileId>","status":"resolved"}'`. The thread has `resolvedAt` and
  `messageCount` 3.
- **Reopen.** Run `node $V ab find role button click --name "Reopen"`. The dock
  button reads `Comments, 1 open`.

## Gotchas

- `list_comments` returns open threads by default. Pass `"status":"resolved"` or
  `"status":"all"` to see resolved ones.
- The reply placeholder `Reply…` is not page text, so `wait --text "Reply…"` never
  matches. Wait for `textarea[aria-label="Reply to comment"]` instead.
- `--name "Reply"` without `--exact` also matches `Reply to comment`.
- Pins are hidden in the share link viewer. Link viewers cannot see or add comments.
